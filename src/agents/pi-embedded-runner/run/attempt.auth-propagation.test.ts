import { describe, expect, it, vi } from "vitest";
import { injectRequestAuthIntoStreamFn } from "./attempt.js";

describe("injectRequestAuthIntoStreamFn", () => {
  it("forwards model.apiKey into stream options when the caller omits it", async () => {
    const inner = vi.fn(() => ({}) as object);
    const wrapped = injectRequestAuthIntoStreamFn(inner as never);

    await wrapped(
      {
        provider: "bailian",
        id: "qwen3.6-plus",
        api: "openai-completions",
        apiKey: "sk-test-model",
      } as never,
      { messages: [] } as never,
      undefined,
    );

    expect(inner).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "sk-test-model",
      }),
    );
  });

  it("derives a bearer token from model headers when model.apiKey is absent", async () => {
    const inner = vi.fn(() => ({}) as object);
    const wrapped = injectRequestAuthIntoStreamFn(inner as never);

    await wrapped(
      {
        provider: "bailian",
        id: "qwen3.6-plus",
        api: "openai-completions",
        headers: {
          Authorization: "Bearer sk-test-header",
          "X-Test": "1",
        },
      } as never,
      { messages: [] } as never,
      { headers: { "X-Existing": "ok" } } as never,
    );

    expect(inner).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "sk-test-header",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test-header",
          "X-Test": "1",
          "X-Existing": "ok",
        }),
      }),
    );
  });

  it("preserves an explicit apiKey passed by the caller", async () => {
    const inner = vi.fn(() => ({}) as object);
    const wrapped = injectRequestAuthIntoStreamFn(inner as never);

    await wrapped(
      {
        provider: "bailian",
        id: "qwen3.6-plus",
        api: "openai-completions",
        apiKey: "sk-test-model",
      } as never,
      { messages: [] } as never,
      { apiKey: "sk-explicit" } as never,
    );

    expect(inner).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "sk-explicit",
      }),
    );
  });
});
