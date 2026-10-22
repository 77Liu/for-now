/**
 * 受控预算阶段的派发能力与仅进程内部可验证的未调用证明。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：证明必须在阶段关闭且从未进入provider后产生；JSON或HTTP字段不能伪造私有能力。
 */
import { randomBytes } from "node:crypto";
type Proof = { reservationId: string; stageId: string; dispatchAttemptId: string; reason: "cancelled" | "timeout" | "stale" | "failed_before_io" };
const proofs = new WeakMap<object, Proof>();
/** 创建单阶段执行能力；同步guard与实际provider调用之间不插入await。
 * @since unreleased
 */
export function createDispatchAttempt() {
  const id = randomBytes(12).toString("base64url"); let invoked = false, closed = false;
  return Object.freeze({
    id,
    invoke<T>(operation: () => T, guard: () => void): T {
      if (closed || invoked) throw new Error("预算阶段派发能力已结束");
      guard(); invoked = true; return operation();
    },
    close() { closed = true; },
    get invoked() { return invoked; },
    proof(reservationId: string, stageId: string, reason: Proof["reason"]) {
      if (!closed || invoked) throw new Error("已调用或仍可派发的阶段不能证明未调用");
      if (!["cancelled", "timeout", "stale", "failed_before_io"].includes(reason)) throw new Error("未调用证明原因无效");
      const capability = Object.freeze({}); proofs.set(capability, { reservationId, stageId, dispatchAttemptId: id, reason }); return capability;
    }
  });
}
/** 验证内部证明，不接受序列化后的能力；返回只读身份副本供预算事务匹配。
 * @since unreleased
 */
export function readDispatchProof(capability: object): Readonly<Proof> | null {
  const proof = capability && proofs.get(capability); return proof ? Object.freeze({ ...proof }) : null;
}
