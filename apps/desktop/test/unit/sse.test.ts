import { describe, expect, it } from "vitest";
import { readSse } from "../../src/main/controller.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("readSse", () => {
  it("parses events split across chunks and skips pings, comments and junk", async () => {
    const got: unknown[] = [];
    await readSse(
      streamOf([
        'data: {"type":"hel',
        'lo"}\n\n',
        "event: ping\ndata: {}\n\n",
        ": comment\n\n",
        "data: not json\n\n",
        'data: {"a":1}\r\n\r\ndata: {"b":',
        "2}\n\n",
      ]),
      (d) => got.push(d),
    );
    expect(got).toEqual([{ type: "hello" }, { a: 1 }, { b: 2 }]);
  });
});
