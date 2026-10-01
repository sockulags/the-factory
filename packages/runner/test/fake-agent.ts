// A scripted ACP agent for tests. Speaks real ACP over stdio via the SDK.
// Behaviour toggles (env):
//   FAKE_STATE_DIR   where sessions persist between processes (required)
//   FAKE_LOAD=1      advertise + implement session/load (replays history)
//   FAKE_RESUME=1    advertise + implement session/resume
//   FAKE_USAGE=1     report token usage and usage_update
//   FAKE_DIRECT=1    write files itself instead of via the client (ignores read-only)
//   FAKE_NO_PERMISSION=1  never ask for permission before editing
//   FAKE_AUTH=1      reject prompts with auth_required
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  AgentSideConnection,
  type ClientCapabilities,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

interface Stored {
  cwd: string;
  history: { role: "user" | "agent"; text: string }[];
  memory: Record<string, string>;
}

const env = process.env;
const stateDir = env.FAKE_STATE_DIR ?? "/tmp/fake-agent";
const cancelled = new Set<string>();
let clientCaps: ClientCapabilities = {};

const file = (id: string) => path.join(stateDir, `${id}.json`);
const load = async (id: string): Promise<Stored> => JSON.parse(await readFile(file(id), "utf8"));
const save = async (id: string, s: Stored) => {
  await mkdir(stateDir, { recursive: true });
  await writeFile(file(id), JSON.stringify(s));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connection = new AgentSideConnection(
  (conn): Agent => {
    const say = (sessionId: string, text: string) =>
      conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

    return {
      async initialize(params) {
        clientCaps = params.clientCapabilities ?? {};
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: "fake-agent", version: "1.0.0" },
          agentCapabilities: {
            loadSession: env.FAKE_LOAD === "1",
            sessionCapabilities: env.FAKE_RESUME === "1" ? { resume: {} } : {},
            promptCapabilities: { embeddedContext: true },
          },
          authMethods: [{ id: "cli-login", name: "CLI login" }],
        };
      },
      async newSession({ cwd }) {
        const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
        await save(sessionId, { cwd, history: [], memory: {} });
        return {
          sessionId,
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
          },
        };
      },
      async loadSession({ sessionId }) {
        if (env.FAKE_LOAD !== "1") throw RequestError.methodNotFound("session/load");
        const s = await load(sessionId);
        for (const h of s.history) {
          const update: SessionUpdate =
            h.role === "user"
              ? { sessionUpdate: "user_message_chunk", content: { type: "text", text: h.text } }
              : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: h.text } };
          await conn.sessionUpdate({ sessionId, update });
        }
        return {};
      },
      async resumeSession({ sessionId }) {
        if (env.FAKE_RESUME !== "1") throw RequestError.methodNotFound("session/resume");
        await load(sessionId);
        return {};
      },
      async authenticate() {
        return {};
      },
      async setSessionMode() {
        return {};
      },
      async cancel({ sessionId }) {
        cancelled.add(sessionId);
      },
      async prompt({ sessionId, prompt }) {
        if (env.FAKE_AUTH === "1") throw RequestError.authRequired();
        const s = await load(sessionId);
        const full = prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
        s.history.push({ role: "user", text: full });
        // Act only on the actual request, not on quoted context from The Factory.
        const text = full.replace(/<factory-context>[\s\S]*?<\/factory-context>\s*/, "");
        cancelled.delete(sessionId);
        let reply = "I don't know how to do that.";
        const word = text.match(/exactly the word (\w+)/);
        const plant = text.match(/codeword for later: (\S+?)\./);
        const create = text.match(
          /Create a file named (\S+) .*containing exactly the text: (.*)$/m,
        );
        const count = text.match(/Count from 1 to (\d+)/);

        const echo = text.match(/^Say: ([\s\S]+)$/);

        const wantsHandover = text.includes("Write the step handover");
        const checksFailed = /The checks failed/.test(text) && env.FAKE_ON_CHECKS_FAILED;

        if (wantsHandover) {
          const good = env.FAKE_BAD_HANDOVER !== "always";
          reply = good
            ? `Here you go:\n\n\`\`\`json\n${JSON.stringify({
                goal: `Handled: ${s.history[0]?.text.split("\n")[0]?.slice(0, 80) ?? "step"}`,
                decisions: [{ decision: "Kept it simple", why: "Fake agent" }],
                rejected: [],
                filesTouched: [],
                verify: ["Look at the thread"],
                openQuestions: [],
              })}\n\`\`\``
            : "I'd rather not write JSON.";
        } else if (checksFailed) {
          const target = path.join(s.cwd, env.FAKE_ON_CHECKS_FAILED ?? "fixed.txt");
          await conn.writeTextFile({ sessionId, path: target, content: "ok\n" });
          reply = `Fixed by creating ${env.FAKE_ON_CHECKS_FAILED}.`;
        } else if (echo) reply = echo[1] ?? "";
        else if (word) reply = word[1] ?? "";
        else if (plant) {
          s.memory.codeword = plant[1] ?? "";
          reply = "OK";
        } else if (/What was the codeword/.test(text)) {
          reply = s.memory.codeword ?? "I don't remember.";
        } else if (create) {
          const [, name = "", content = ""] = create;
          const target = path.join(s.cwd, name);
          const toolCallId = `t-${Date.now()}`;
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: `Write ${name}`,
              kind: "edit",
              status: "pending",
            },
          });
          let allowed = true;
          if (env.FAKE_NO_PERMISSION !== "1") {
            const res = await conn.requestPermission({
              sessionId,
              toolCall: { toolCallId, title: `Write ${name}`, kind: "edit" },
              options: [
                { optionId: "yes", name: "Allow", kind: "allow_once" },
                { optionId: "always", name: "Always allow", kind: "allow_always" },
                { optionId: "no", name: "Reject", kind: "reject_once" },
              ],
            });
            allowed = res.outcome.outcome === "selected" && res.outcome.optionId !== "no";
          }
          if (!allowed) reply = "Permission denied, not writing.";
          else if (env.FAKE_DIRECT === "1" || !clientCaps.fs?.writeTextFile) {
            await writeFile(target, content);
            reply = `Wrote ${name}.`;
          } else {
            try {
              await conn.writeTextFile({ sessionId, path: target, content });
              reply = `Wrote ${name}.`;
            } catch (err) {
              reply = `Could not write: ${(err as Error).message}`;
            }
          }
        } else if (count) {
          for (let i = 1; i <= Number(count[1]); i++) {
            if (cancelled.has(sessionId)) {
              await save(sessionId, s);
              return { stopReason: "cancelled" };
            }
            await say(sessionId, `${i}\n`);
            await sleep(20);
          }
          reply = "";
        }

        if (reply) await say(sessionId, reply);
        s.history.push({ role: "agent", text: reply });
        await save(sessionId, s);
        if (env.FAKE_USAGE === "1") {
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: 1200,
              size: 200000,
              cost: { amount: 0.01, currency: "USD" },
            },
          });
          return {
            stopReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          };
        }
        return { stopReason: "end_turn" };
      },
    };
  },
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);

void connection.closed.then(() => process.exit(0));
