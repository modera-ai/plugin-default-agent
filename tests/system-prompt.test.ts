import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@modera/contracts";
import { withSystemPolicy } from "../src/system-prompt";

const userMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  content: "修改项目并验证",
  createdAt: new Date(1).toISOString(),
};

describe("withSystemPolicy", () => {
  it("exposes image attachment IDs for authorized edits without mutating stored input", () => {
    const message: ChatMessage = { ...userMessage, attachments: [{ id: "image-id", name: "reference.png", mimeType: "image/png", size: 10 }] };
    const result = withSystemPolicy([message]);
    expect(result[1]?.content).toContain("attachment:<id>");
    expect(result[1]?.content).toContain('"id":"image-id"');
    expect(message.content).toBe(userMessage.content);
  });
  it("prepends the stable agent contract without mutating history", () => {
    const messages = [userMessage];
    const result = withSystemPolicy(messages);

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(userMessage);
    expect(result[0]).toMatchObject({
      id: "modera-system-policy",
      role: "system",
      createdAt: new Date(0).toISOString(),
    });
    expect(result[0]?.content).toContain("把任务可靠地推进到可验证的结果");
    expect(result[0]?.content).toContain("不覆盖、不回滚、不清理");
    expect(result[0]?.content).toContain("运行与改动风险相称的最小有效验证");
    expect(result[0]?.content).not.toContain("当前启用能力的使用指导");
  });

  it("appends only enabled capability guidance after the stable policy", () => {
    const result = withSystemPolicy(
      [userMessage],
      ["先读取相关文件。", "使用终端执行测试。"],
    );
    const content = result[0]?.content ?? "";

    expect(content).toContain(
      "当前启用能力的使用指导：\n- 先读取相关文件。\n- 使用终端执行测试。",
    );
    expect(content.indexOf("## 审批与拒绝")).toBeLessThan(
      content.indexOf("当前启用能力的使用指导"),
    );
  });
});
