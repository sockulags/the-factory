import type { DocProposalDto } from "@factory/protocol";
import { timeAgo } from "./format.js";

const STATUS: Record<DocProposalDto["status"], string> = {
  pending: "Waiting for review",
  approved: "Approved and committed",
  discarded: "Discarded",
  superseded: "Replaced by a newer proposal",
};

/** The docs step's proposed changes as a reviewable diff. */
export function DocProposalView({ proposals }: { proposals: DocProposalDto[] }) {
  const latest = proposals.at(-1);
  if (!latest) return <p className="muted pad">No documentation changes proposed yet.</p>;
  return (
    <div className="pad docs-proposal">
      <p>
        <strong>{STATUS[latest.status]}</strong>{" "}
        <span className="muted small">· {timeAgo(latest.createdAt)}</span>
      </p>
      {latest.files.length === 0 ? (
        <p className="muted">The agent proposed no documentation changes.</p>
      ) : (
        <ul className="plain small">
          {latest.files.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> <span className="added">+{f.added}</span>{" "}
              <span className="removed">−{f.removed}</span>
            </li>
          ))}
        </ul>
      )}
      {latest.outsideDocs.length > 0 && (
        <p className="warning small">
          Also changed outside the docs during this step: {latest.outsideDocs.join(", ")}. They are
          committed with the step unless you request changes.
        </p>
      )}
      {latest.patch && <Diff patch={latest.patch} />}
    </div>
  );
}

function Diff({ patch }: { patch: string }) {
  return (
    <pre className="diff" title="Documentation diff">
      {patch.split("\n").map((line, i) => {
        const cls =
          line.startsWith("+++") ||
          line.startsWith("---") ||
          line.startsWith("diff ") ||
          line.startsWith("index ")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static lines of one diff
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
