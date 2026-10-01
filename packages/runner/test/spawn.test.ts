import { describe, expect, it } from "vitest";
import { quoteWindowsArg } from "../src/spawn.js";

describe("quoteWindowsArg", () => {
  it("leaves plain arguments alone", () => {
    expect(quoteWindowsArg("-y")).toBe("-y");
    expect(quoteWindowsArg("@agentclientprotocol/claude-agent-acp@latest")).toBe(
      "@agentclientprotocol/claude-agent-acp@latest",
    );
  });
  it("quotes spaces, shell metacharacters and empty strings", () => {
    expect(quoteWindowsArg("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteWindowsArg("a&b")).toBe('"a&b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say ""hi"""');
    expect(quoteWindowsArg("")).toBe('""');
  });
});
