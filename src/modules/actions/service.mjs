import crypto from "node:crypto";
import { localDateKey } from "../../shared/time/index.mjs";
import { recordVersion } from "../../shared/validation/index.mjs";
import {
  actionCompletionFeedback,
  actionPayload,
  assertActionsData,
  habitAdjustmentPayload,
  habitCheckinPayload,
  habitPayload,
  normalizeActionStatus,
  normalizeExpectedVersion,
  normalizeHabitStatus,
  normalizeIdentifier,
  sameFrequency
} from "./schema.mjs";

const clone = value => structuredClone(value);
const historyOf = value => Array.isArray(value) ? value : [];
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const priorRequestRecord = (data, collection, trashType, clientRequestId) => (
  data[collection].find(item => item.clientRequestId === clientRequestId)
  || (Array.isArray(data.trash)
    ? data.trash.find(item => item.type === trashType && item.payload?.clientRequestId === clientRequestId)?.payload
    : null)
);

function sameSource(left, right) {
  return (left == null && right == null)
    || (left?.type === right?.type && left?.id === right?.id && left?.label === right?.label);
}

function timestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Actions service now() must return a valid date");
  return parsed.toISOString();
}

function generatedId(createId) {
  const parsed = normalizeIdentifier(createId(), "生成的 ID");
  if (parsed.error) throw new TypeError(parsed.error);
  return parsed.value;
}

function versionResult(record, expectedVersion) {
  const currentVersion = recordVersion(record.version);
  return expectedVersion != null && expectedVersion !== currentVersion
    ? { conflict: { versionConflict: true, currentVersion } }
    : { currentVersion };
}

function actionTransition(action, nextStatus, changedAt, reason, feedback = null) {
  const currentStatus = action.status || "todo";
  if (currentStatus === nextStatus) return action;
  const completing = nextStatus === "done";
  const undoing = currentStatus === "done" && nextStatus !== "done";
  const revokeFeedback = value => value
    ? { ...value, learningAllowed: false, revokedAt: changedAt }
    : value;
  return {
    ...action,
    status: nextStatus,
    completedAt: completing ? changedAt : "",
    statusBeforeCompletion: completing ? currentStatus : undoing ? "" : action.statusBeforeCompletion || "",
    ...(undoing && action.completionFeedback
      ? { completionFeedback: revokeFeedback(action.completionFeedback) }
      : {}),
    statusHistory: [
      ...historyOf(action.statusHistory).map(entry => (
        undoing && entry?.feedback
          ? { ...entry, feedback: revokeFeedback(entry.feedback) }
          : entry
      )),
      {
        from: currentStatus,
        to: nextStatus,
        reason,
        changedAt,
        ...(feedback ? { feedback: clone(feedback) } : {})
      }
    ]
  };
}

function habitTransition(habit, nextStatus, changedAt, reason) {
  const currentStatus = habit.status || "active";
  if (currentStatus === nextStatus) return habit;
  return {
    ...habit,
    status: nextStatus,
    statusHistory: [
      ...historyOf(habit.statusHistory),
      { from: currentStatus, to: nextStatus, reason, changedAt }
    ]
  };
}

function deletionLocation(type, collection, items, index, extra = {}) {
  const { parentId = "", ...metadata } = extra;
  return {
    type,
    resourceId: items[index].id,
    version: recordVersion(items[index].version),
    location: {
      kind: "collection",
      collection,
      index,
      ...(parentId ? { parentId } : {})
    },
    ...metadata
  };
}

export function createActionsService({
  repository,
  now = () => new Date().toISOString(),
  today = () => localDateKey(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Actions service requires a repository with read() and update()");
  }

  const readData = async () => assertActionsData(await repository.read());
  const updateData = async mutate => clone(await repository.update(data => mutate(assertActionsData(data))));
  const createIdempotently = (scope, key, requestHash, mutate) => (
    key && typeof repository.executeIdempotent === "function"
      ? repository.executeIdempotent(
          { scope, key, requestHash },
          data => mutate(assertActionsData(data), false),
          { onReplay: result => ({ ...result, duplicate: true }) }
        ).then(clone)
      : updateData(data => mutate(data, true))
  );

  async function listActions() {
    return clone((await readData()).actions);
  }

  async function getAction(id) {
    const parsedId = normalizeIdentifier(id, "行动 ID");
    if (parsedId.error) return null;
    const action = (await readData()).actions.find(item => item.id === parsedId.value);
    return action ? clone(action) : null;
  }

  async function createAction(input, { clientRequestId = "" } = {}) {
    const parsed = actionPayload(input);
    if (parsed.error) return parsed;
    const createdAt = timestamp(now());
    const requestHash = clientRequestId ? requestDigest(parsed.value) : "";
    return createIdempotently("actions.create", clientRequestId, requestHash, (data, useLegacyLookup) => {
      if (clientRequestId && useLegacyLookup) {
        const duplicate = priorRequestRecord(data, "actions", "action", clientRequestId);
        if (duplicate) {
          return duplicate.requestHash === requestHash
            ? { value: duplicate, duplicate: true }
            : { conflict: true, reason: "idempotencyKeyReused" };
        }
      }
      const id = generatedId(createId);
      if (data.actions.some(item => item.id === id)) return { conflict: true, reason: "duplicateId" };
      let action = {
        id,
        createdAt,
        updatedAt: createdAt,
        version: 1,
        completedAt: "",
        statusBeforeCompletion: "",
        statusHistory: [],
        ...parsed.value,
        ...(clientRequestId ? { clientRequestId, requestHash } : {})
      };
      if (action.status === "done") {
        action = actionTransition({ ...action, status: "todo" }, "done", createdAt, "createCompleted");
      }
      data.actions.unshift(action);
      return { value: action };
    });
  }

  async function updateActionRecord(id, input, options = {}, reasonOverride = "") {
    const parsedId = normalizeIdentifier(id, "行动 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const changedAt = timestamp(now());
    return updateData(data => {
      const index = data.actions.findIndex(item => item.id === parsedId.value);
      if (index < 0) return { missing: true };
      const current = data.actions[index];
      const version = versionResult(current, parsedVersion.value);
      if (version.conflict) return version.conflict;
      const parsed = actionPayload(input, current);
      if (parsed.error) return parsed;
      const statusChanged = parsed.value.status !== current.status;
      const fieldsChanged = parsed.value.title !== current.title
        || parsed.value.priority !== current.priority
        || !sameSource(parsed.value.sourceRef, current.sourceRef);
      if (!statusChanged && !fieldsChanged) return { value: current, unchanged: true };
      const reason = reasonOverride
        || (parsed.value.status === "done" ? "complete" : current.status === "done" ? "undoCompletion" : "statusChange");
      const transitioned = statusChanged
        ? actionTransition(current, parsed.value.status, changedAt, reason)
        : current;
      const next = {
        ...transitioned,
        title: parsed.value.title,
        priority: parsed.value.priority,
        sourceRef: parsed.value.sourceRef,
        updatedAt: changedAt,
        version: version.currentVersion + 1
      };
      data.actions[index] = next;
      return { value: next };
    });
  }

  const updateAction = (id, input, options) => updateActionRecord(id, input, options);

  function setActionStatus(id, status, options = {}) {
    const parsedStatus = normalizeActionStatus(status);
    if (parsedStatus.error) return Promise.resolve(parsedStatus);
    return updateActionRecord(id, { status: parsedStatus.value }, options);
  }

  async function completeAction(id, input = {}, options = {}) {
    if (Object.hasOwn(input || {}, "expectedVersion")
      && !Object.hasOwn(input || {}, "outcome")
      && !Object.hasOwn(input || {}, "note")
      && !Object.hasOwn(input || {}, "learningAllowed")) {
      options = input;
      input = {};
    }
    const parsedId = normalizeIdentifier(id, "行动 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const feedback = actionCompletionFeedback(input);
    if (feedback.error) return feedback;
    const changedAt = timestamp(now());
    return updateData(data => {
      const index = data.actions.findIndex(item => item.id === parsedId.value);
      if (index < 0) return { missing: true };
      const current = data.actions[index];
      const version = versionResult(current, parsedVersion.value);
      if (version.conflict) return version.conflict;
      if (current.status === "done") return { value: current, unchanged: true };
      const completionFeedback = feedback.value
        ? { ...feedback.value, recordedAt: changedAt }
        : null;
      const next = {
        ...actionTransition(current, "done", changedAt, "complete", completionFeedback),
        ...(completionFeedback ? { completionFeedback } : {}),
        updatedAt: changedAt,
        version: version.currentVersion + 1
      };
      data.actions[index] = next;
      return { value: next };
    });
  }

  async function undoActionCompletion(id, options = {}) {
    const parsedId = normalizeIdentifier(id, "行动 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const changedAt = timestamp(now());
    return updateData(data => {
      const index = data.actions.findIndex(item => item.id === parsedId.value);
      if (index < 0) return { missing: true };
      const current = data.actions[index];
      const version = versionResult(current, parsedVersion.value);
      if (version.conflict) return version.conflict;
      if (current.status !== "done") return { invalidState: true, currentStatus: current.status };
      const target = ["todo", "doing"].includes(current.statusBeforeCompletion)
        ? current.statusBeforeCompletion
        : "todo";
      const next = {
        ...actionTransition(current, target, changedAt, "undoCompletion"),
        updatedAt: changedAt,
        version: version.currentVersion + 1
      };
      data.actions[index] = next;
      return { value: next };
    });
  }

  async function locateActionDeletion(id, options = {}) {
    const parsedId = normalizeIdentifier(id, "行动 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const data = await readData();
    const index = data.actions.findIndex(item => item.id === parsedId.value);
    if (index < 0) return { missing: true };
    const version = versionResult(data.actions[index], parsedVersion.value);
    return version.conflict || { value: deletionLocation("action", "actions", data.actions, index) };
  }

  async function listHabits() {
    return clone((await readData()).habits);
  }

  async function getHabit(id) {
    const parsedId = normalizeIdentifier(id, "习惯 ID");
    if (parsedId.error) return null;
    const habit = (await readData()).habits.find(item => item.id === parsedId.value);
    return habit ? clone(habit) : null;
  }

  async function createHabit(input, { clientRequestId = "" } = {}) {
    const parsed = habitPayload(input);
    if (parsed.error) return parsed;
    const createdAt = timestamp(now());
    const requestHash = clientRequestId ? requestDigest(parsed.value) : "";
    return createIdempotently("habits.create", clientRequestId, requestHash, (data, useLegacyLookup) => {
      if (clientRequestId && useLegacyLookup) {
        const duplicate = priorRequestRecord(data, "habits", "habit", clientRequestId);
        if (duplicate) {
          return duplicate.requestHash === requestHash
            ? { value: duplicate, duplicate: true }
            : { conflict: true, reason: "idempotencyKeyReused" };
        }
      }
      const id = generatedId(createId);
      if (data.habits.some(item => item.id === id)) return { conflict: true, reason: "duplicateId" };
      const adjustmentHistory = parsed.value.adjustment
        ? [{
            id: generatedId(createId),
            note: parsed.value.adjustment,
            fromFrequency: null,
            toFrequency: clone(parsed.value.frequency),
            createdAt
          }]
        : [];
      const habit = {
        id,
        createdAt,
        updatedAt: createdAt,
        version: 1,
        title: parsed.value.title,
        frequency: parsed.value.frequency,
        status: parsed.value.status,
        statusHistory: [],
        adjustmentHistory,
        ...(clientRequestId ? { clientRequestId, requestHash } : {})
      };
      data.habits.unshift(habit);
      return { value: habit };
    });
  }

  async function updateHabitRecord(id, input, options = {}, statusReason = "") {
    const parsedId = normalizeIdentifier(id, "习惯 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const changedAt = timestamp(now());
    return updateData(data => {
      const index = data.habits.findIndex(item => item.id === parsedId.value);
      if (index < 0) return { missing: true };
      const current = data.habits[index];
      const version = versionResult(current, parsedVersion.value);
      if (version.conflict) return version.conflict;
      const parsed = habitPayload(input, current);
      if (parsed.error) return parsed;
      const frequencyChanged = !sameFrequency(parsed.value.frequency, current.frequency);
      const statusChanged = parsed.value.status !== current.status;
      const titleChanged = parsed.value.title !== current.title;
      const hasAdjustment = Boolean(parsed.value.adjustment);
      if (!frequencyChanged && !statusChanged && !titleChanged && !hasAdjustment) {
        return { value: current, unchanged: true };
      }
      const reason = statusReason || (parsed.value.status === "active" ? "enable" : "pause");
      const transitioned = statusChanged
        ? habitTransition(current, parsed.value.status, changedAt, reason)
        : current;
      const adjustmentHistory = frequencyChanged || hasAdjustment
        ? [
            ...historyOf(current.adjustmentHistory),
            {
              id: generatedId(createId),
              note: parsed.value.adjustment,
              fromFrequency: clone(current.frequency),
              toFrequency: clone(parsed.value.frequency),
              createdAt: changedAt
            }
          ]
        : historyOf(current.adjustmentHistory);
      const next = {
        ...transitioned,
        title: parsed.value.title,
        frequency: parsed.value.frequency,
        adjustmentHistory,
        updatedAt: changedAt,
        version: version.currentVersion + 1
      };
      data.habits[index] = next;
      return { value: next };
    });
  }

  const updateHabit = (id, input, options) => updateHabitRecord(id, input, options);

  function setHabitEnabled(id, enabled, options = {}) {
    if (typeof enabled !== "boolean") return Promise.resolve({ error: "习惯启停值必须是布尔值" });
    return updateHabitRecord(id, { status: enabled ? "active" : "paused" }, options, enabled ? "enable" : "pause");
  }

  const enableHabit = (id, options = {}) => setHabitEnabled(id, true, options);
  const disableHabit = (id, options = {}) => setHabitEnabled(id, false, options);

  async function recordHabitAdjustment(id, input, options = {}) {
    const parsedId = normalizeIdentifier(id, "习惯 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const parsed = habitAdjustmentPayload(input);
    if (parsed.error) return parsed;
    const changedAt = timestamp(now());
    return updateData(data => {
      const index = data.habits.findIndex(item => item.id === parsedId.value);
      if (index < 0) return { missing: true };
      const current = data.habits[index];
      const version = versionResult(current, parsedVersion.value);
      if (version.conflict) return version.conflict;
      const frequency = parsed.value.frequency || current.frequency;
      const adjustment = {
        id: generatedId(createId),
        note: parsed.value.note,
        fromFrequency: clone(current.frequency),
        toFrequency: clone(frequency),
        createdAt: changedAt
      };
      const next = {
        ...current,
        frequency,
        adjustmentHistory: [...historyOf(current.adjustmentHistory), adjustment],
        updatedAt: changedAt,
        version: version.currentVersion + 1
      };
      data.habits[index] = next;
      return { value: next, adjustment };
    });
  }

  async function locateHabitDeletion(id, options = {}) {
    const parsedId = normalizeIdentifier(id, "习惯 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const data = await readData();
    const index = data.habits.findIndex(item => item.id === parsedId.value);
    if (index < 0) return { missing: true };
    const version = versionResult(data.habits[index], parsedVersion.value);
    if (version.conflict) return version.conflict;
    const dependents = data.habitCheckins
      .map((item, checkinIndex) => ({ item, checkinIndex }))
      .filter(({ item }) => item.habitId === parsedId.value)
      .map(({ checkinIndex }) => deletionLocation(
        "habitCheckin",
        "habitCheckins",
        data.habitCheckins,
        checkinIndex,
        { parentId: parsedId.value }
      ));
    return {
      value: deletionLocation("habit", "habits", data.habits, index, { dependents })
    };
  }

  async function listHabitCheckins({ habitId = "", occurredOn = "" } = {}) {
    const data = await readData();
    return clone(data.habitCheckins.filter(item => (
      (!habitId || item.habitId === habitId)
      && (!occurredOn || item.occurredOn === occurredOn)
    )));
  }

  async function getHabitCheckin(id) {
    const parsedId = normalizeIdentifier(id, "习惯打卡 ID");
    if (parsedId.error) return null;
    const checkin = (await readData()).habitCheckins.find(item => item.id === parsedId.value);
    return checkin ? clone(checkin) : null;
  }

  async function checkInHabit(habitId, input = {}, { clientRequestId = "" } = {}) {
    const parsedId = normalizeIdentifier(habitId, "习惯 ID");
    if (parsedId.error) return parsedId;
    const parsed = habitCheckinPayload(input, { today: today() });
    if (parsed.error) return parsed;
    const createdAt = timestamp(now());
    const requestHash = clientRequestId ? requestDigest({ habitId: parsedId.value, ...parsed.value }) : "";
    return createIdempotently("habitCheckins.create", clientRequestId, requestHash, (data, useLegacyLookup) => {
      if (clientRequestId && useLegacyLookup) {
        const replay = priorRequestRecord(data, "habitCheckins", "habitCheckin", clientRequestId);
        if (replay) {
          return replay.requestHash === requestHash
            ? { value: replay, duplicate: true }
            : { conflict: true, reason: "idempotencyKeyReused" };
        }
      }
      const habit = data.habits.find(item => item.id === parsedId.value);
      if (!habit) return { missing: true };
      const duplicate = data.habitCheckins.find(item => (
        item.habitId === parsedId.value && item.occurredOn === parsed.value.occurredOn
      ));
      if (duplicate) return { value: duplicate, duplicate: true };
      if (habit.status !== "active") return { inactive: true };
      const checkin = {
        id: generatedId(createId),
        habitId: parsedId.value,
        createdAt,
        updatedAt: createdAt,
        version: 1,
        ...parsed.value,
        ...(clientRequestId ? { clientRequestId, requestHash } : {})
      };
      data.habitCheckins.unshift(checkin);
      return { value: checkin, duplicate: false };
    });
  }

  async function updateHabitCheckin(id, input, options = {}) {
    const parsedId = normalizeIdentifier(id, "习惯打卡 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const changedAt = timestamp(now());
    return updateData(data => {
      const index = data.habitCheckins.findIndex(item => item.id === parsedId.value);
      if (index < 0) return { missing: true };
      const current = data.habitCheckins[index];
      const version = versionResult(current, parsedVersion.value);
      if (version.conflict) return version.conflict;
      const parsed = habitCheckinPayload(input, { today: today(), existing: current });
      if (parsed.error) return parsed;
      const duplicate = data.habitCheckins.find(item => (
        item.id !== current.id
        && item.habitId === current.habitId
        && item.occurredOn === parsed.value.occurredOn
      ));
      if (duplicate) return { dateConflict: true, existingId: duplicate.id };
      const changed = parsed.value.occurredOn !== current.occurredOn
        || parsed.value.feeling !== current.feeling
        || parsed.value.adjustment !== current.adjustment;
      if (!changed) return { value: current, unchanged: true };
      const next = {
        ...current,
        ...parsed.value,
        updatedAt: changedAt,
        version: version.currentVersion + 1
      };
      data.habitCheckins[index] = next;
      return { value: next };
    });
  }

  async function locateHabitCheckinDeletion(id, options = {}) {
    const parsedId = normalizeIdentifier(id, "习惯打卡 ID");
    if (parsedId.error) return parsedId;
    const parsedVersion = normalizeExpectedVersion(options.expectedVersion);
    if (parsedVersion.error) return parsedVersion;
    const data = await readData();
    const index = data.habitCheckins.findIndex(item => item.id === parsedId.value);
    if (index < 0) return { missing: true };
    const version = versionResult(data.habitCheckins[index], parsedVersion.value);
    return version.conflict || {
      value: deletionLocation(
        "habitCheckin",
        "habitCheckins",
        data.habitCheckins,
        index,
        { parentId: data.habitCheckins[index].habitId }
      )
    };
  }

  function locateDeletion(type, id, options = {}) {
    if (type === "action") return locateActionDeletion(id, options);
    if (type === "habit") return locateHabitDeletion(id, options);
    if (type === "habitCheckin") return locateHabitCheckinDeletion(id, options);
    return Promise.resolve({ error: "删除资源类型无效" });
  }

  return Object.freeze({
    listActions,
    getAction,
    createAction,
    updateAction,
    setActionStatus,
    completeAction,
    undoActionCompletion,
    undoAction: undoActionCompletion,
    reopenAction: undoActionCompletion,
    locateActionDeletion,
    deleteAction: locateActionDeletion,
    listHabits,
    getHabit,
    createHabit,
    updateHabit,
    setHabitEnabled,
    enableHabit,
    disableHabit,
    recordHabitAdjustment,
    locateHabitDeletion,
    deleteHabit: locateHabitDeletion,
    listHabitCheckins,
    getHabitCheckin,
    checkInHabit,
    updateHabitCheckin,
    locateHabitCheckinDeletion,
    deleteHabitCheckin: locateHabitCheckinDeletion,
    locateDeletion
  });
}
