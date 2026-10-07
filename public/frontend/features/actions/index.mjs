const ACTION_STATUS_META = {
  todo: { label: "待办", order: 0 },
  doing: { label: "进行中", order: 1 },
  done: { label: "已完成", order: 2 }
};
const PRIORITY_META = {
  P0: { label: "P0", order: 0 },
  P1: { label: "P1", order: 1 },
  P2: { label: "P2", order: 2 },
  P3: { label: "P3", order: 3 },
  none: { label: "未分级", order: 4 }
};

const copy = value => {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  }
  return value;
};

const deepFreeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const command = value => deepFreeze(copy(value));
const text = value => typeof value === "string" ? value.trim() : "";
const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

function requiredId(value, label) {
  const id = text(value);
  if (!id) throw new TypeError(`${label}不能为空`);
  return id;
}

function optionalVersion(value) {
  if (value == null || value === "") return undefined;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new TypeError("版本必须是正整数");
  return version;
}

function withVersion(value, version) {
  const parsed = optionalVersion(version);
  return parsed == null ? value : { ...value, expectedVersion: parsed };
}

function actionInput(input = {}, partial = false) {
  const value = {};
  if (!partial || Object.hasOwn(input, "title")) value.title = text(input.title);
  if (!partial || Object.hasOwn(input, "priority")) value.priority = text(input.priority) || "none";
  if (Object.hasOwn(input, "status")) value.status = text(input.status);
  if (Object.hasOwn(input, "sourceRef") || Object.hasOwn(input, "source")) {
    const source = input.sourceRef ?? input.source;
    value.sourceRef = source == null
      ? null
      : { type: text(source.type ?? source.resourceType), id: text(source.id ?? source.resourceId), label: text(source.label) };
  }
  return value;
}

function habitInput(input = {}, partial = false) {
  const value = {};
  if (!partial || Object.hasOwn(input, "title")) value.title = text(input.title);
  if (Object.hasOwn(input, "frequency")) value.frequency = copy(input.frequency);
  if (Object.hasOwn(input, "status")) value.status = text(input.status);
  if (Object.hasOwn(input, "enabled")) value.enabled = input.enabled;
  if (Object.hasOwn(input, "adjustment")) value.adjustment = text(input.adjustment);
  return value;
}

function checkinInput(input = {}) {
  const value = {};
  if (Object.hasOwn(input, "occurredOn") || Object.hasOwn(input, "date")) {
    value.occurredOn = text(input.occurredOn ?? input.date);
  }
  if (Object.hasOwn(input, "feeling")) value.feeling = text(input.feeling);
  if (Object.hasOwn(input, "adjustment")) value.adjustment = text(input.adjustment);
  return value;
}

function sourceLabel(sourceRef) {
  if (!sourceRef) return "独立行动";
  return sourceRef.label || `${sourceRef.type}:${sourceRef.id}`;
}

function actionViewModel(action) {
  const status = ACTION_STATUS_META[action.status] ? action.status : "todo";
  const priority = PRIORITY_META[action.priority] ? action.priority : "none";
  return {
    id: action.id,
    title: action.title || "",
    priority,
    priorityLabel: PRIORITY_META[priority].label,
    status,
    statusLabel: ACTION_STATUS_META[status].label,
    source: action.sourceRef ? copy(action.sourceRef) : null,
    sourceLabel: sourceLabel(action.sourceRef),
    version: Number(action.version) || 1,
    createdAt: action.createdAt || "",
    updatedAt: action.updatedAt || action.createdAt || "",
    completedAt: action.completedAt || "",
    completionFeedback: action.completionFeedback
      ? copy(action.completionFeedback)
      : null,
    sync: action._sync ? copy(action._sync) : null,
    transitionCount: Array.isArray(action.statusHistory) ? action.statusHistory.length : 0,
    canComplete: status !== "done",
    canUndoCompletion: status === "done"
  };
}

function compareActions(left, right) {
  const priority = PRIORITY_META[left.priority].order - PRIORITY_META[right.priority].order;
  if (priority) return priority;
  return String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id);
}

function shiftDateKey(dateKey, days) {
  if (!dateKeyPattern.test(dateKey)) return "";
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function weeklyStart(dateKey) {
  if (!dateKeyPattern.test(dateKey)) return "";
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return "";
  const offset = (date.getUTCDay() + 6) % 7;
  return shiftDateKey(dateKey, -offset);
}

function habitViewModel(habit, checkins, today) {
  const cadence = habit.frequency?.cadence === "weekly" ? "weekly" : "daily";
  const target = cadence === "weekly"
    ? Math.max(1, Math.min(7, Number(habit.frequency?.target) || 1))
    : 1;
  const periodStart = cadence === "weekly" ? weeklyStart(today) : today;
  const periodEnd = cadence === "weekly" ? shiftDateKey(periodStart, 6) : today;
  const ownCheckins = checkins
    .filter(item => item.habitId === habit.id)
    .sort((left, right) => String(right.occurredOn).localeCompare(String(left.occurredOn)));
  const periodCheckins = ownCheckins.filter(item => (
    periodStart && item.occurredOn >= periodStart && item.occurredOn <= periodEnd
  ));
  const todayCheckin = ownCheckins.find(item => item.occurredOn === today) || null;
  const count = new Set(periodCheckins.map(item => item.occurredOn)).size;
  const status = habit.status === "paused" ? "paused" : "active";
  return {
    id: habit.id,
    title: habit.title || "",
    status,
    statusLabel: status === "active" ? "进行中" : "已暂停",
    enabled: status === "active",
    version: Number(habit.version) || 1,
    sync: habit._sync ? copy(habit._sync) : null,
    frequency: { cadence, target },
    frequencyLabel: cadence === "daily" ? "每天" : `每周 ${target} 天`,
    checkedToday: Boolean(todayCheckin),
    todayCheckin: todayCheckin ? copy(todayCheckin) : null,
    canCheckIn: status === "active" && !todayCheckin,
    period: {
      start: periodStart,
      end: periodEnd,
      count,
      target,
      remaining: Math.max(0, target - count),
      complete: count >= target
    },
    latestFeeling: ownCheckins.find(item => item.feeling)?.feeling || "",
    latestAdjustment: ownCheckins.find(item => item.adjustment)?.adjustment
      || habit.adjustmentHistory?.at(-1)?.note
      || "",
    adjustmentCount: Array.isArray(habit.adjustmentHistory) ? habit.adjustmentHistory.length : 0,
    checkins: ownCheckins.map(copy)
  };
}

export function projectActionCommand(data = {}, pendingCommand = {}, sync = {}) {
  const value = {
    ...copy(data),
    actions: Array.isArray(data.actions) ? data.actions.map(copy) : [],
    habits: Array.isArray(data.habits) ? data.habits.map(copy) : [],
    habitCheckins: Array.isArray(data.habitCheckins) ? data.habitCheckins.map(copy) : []
  };
  const marker = {
    status: sync.status === "pending" || sync.status === "committed" ? sync.status : "sending",
    operationId: text(sync.operationId),
    command: text(pendingCommand.type)
  };
  const mark = item => ({ ...item, _sync: marker });
  const update = (items, id, transform) => {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return false;
    items[index] = mark(transform(items[index]));
    return true;
  };
  let changed = false;

  if (pendingCommand.type === "actions.update") {
    changed = update(value.actions, pendingCommand.id, item => ({ ...item, ...copy(pendingCommand.input) }));
  } else if (pendingCommand.type === "actions.setStatus") {
    changed = update(value.actions, pendingCommand.id, item => ({ ...item, status: pendingCommand.status }));
  } else if (pendingCommand.type === "actions.complete") {
    changed = update(value.actions, pendingCommand.id, item => ({
      ...item,
      statusBeforeCompletion: item.status === "done" ? item.statusBeforeCompletion : item.status,
      status: "done",
      completedAt: sync.createdAt || item.completedAt || "",
      ...(pendingCommand.input ? {
        completionFeedback: {
          ...copy(pendingCommand.input),
          recordedAt: sync.createdAt || ""
        }
      } : {})
    }));
  } else if (pendingCommand.type === "actions.undoCompletion") {
    changed = update(value.actions, pendingCommand.id, item => ({
      ...item,
      status: ["todo", "doing"].includes(item.statusBeforeCompletion) ? item.statusBeforeCompletion : "todo",
      completedAt: ""
    }));
  } else if (pendingCommand.type === "actions.delete") {
    const count = value.actions.length;
    value.actions = value.actions.filter(item => item.id !== pendingCommand.id);
    changed = value.actions.length !== count;
  } else if (pendingCommand.type === "habits.setEnabled") {
    changed = update(value.habits, pendingCommand.id, item => ({
      ...item,
      status: pendingCommand.enabled ? "active" : "paused"
    }));
  } else if (pendingCommand.type === "habits.recordAdjustment") {
    changed = update(value.habits, pendingCommand.id, item => ({
      ...item,
      ...(pendingCommand.input?.frequency ? { frequency: copy(pendingCommand.input.frequency) } : {})
    }));
  } else if (pendingCommand.type === "habits.delete") {
    const count = value.habits.length;
    value.habits = value.habits.filter(item => item.id !== pendingCommand.id);
    value.habitCheckins = value.habitCheckins.filter(item => item.habitId !== pendingCommand.id);
    changed = value.habits.length !== count;
  } else if (pendingCommand.type === "habitCheckins.delete") {
    const count = value.habitCheckins.length;
    value.habitCheckins = value.habitCheckins.filter(item => item.id !== pendingCommand.id);
    changed = value.habitCheckins.length !== count;
  }

  return { value, changed };
}

export function createActionsViewModel(data = {}, { today = "" } = {}) {
  const actions = Array.isArray(data.actions) ? data.actions.map(actionViewModel) : [];
  const habits = Array.isArray(data.habits) ? data.habits : [];
  const checkins = Array.isArray(data.habitCheckins) ? data.habitCheckins : [];
  const actionColumns = Object.entries(ACTION_STATUS_META).map(([status, meta]) => {
    const items = actions.filter(item => item.status === status).sort(compareActions);
    return { status, label: meta.label, count: items.length, items };
  });
  const habitItems = habits.map(habit => habitViewModel(habit, checkins, today));
  return {
    actionColumns,
    habits: habitItems,
    summary: {
      actions: actions.length,
      openActions: actions.filter(item => item.status !== "done").length,
      completedActions: actions.filter(item => item.status === "done").length,
      habits: habitItems.length,
      activeHabits: habitItems.filter(item => item.enabled).length,
      checkedToday: habitItems.filter(item => item.checkedToday).length
    }
  };
}

export const buildCreateActionCommand = input => command({
  type: "actions.create",
  input: actionInput(input)
});

export const buildUpdateActionCommand = (id, input, expectedVersion) => command(withVersion({
  type: "actions.update",
  id: requiredId(id, "行动 ID"),
  input: actionInput(input, true)
}, expectedVersion));

export const buildSetActionStatusCommand = (id, status, expectedVersion) => command(withVersion({
  type: "actions.setStatus",
  id: requiredId(id, "行动 ID"),
  status: text(status)
}, expectedVersion));

export const buildCompleteActionCommand = (id, inputOrVersion, expectedVersion) => {
  const input = inputOrVersion && typeof inputOrVersion === "object"
    ? {
        outcome: text(inputOrVersion.outcome) || "unsure",
        note: text(inputOrVersion.note),
        learningAllowed: inputOrVersion.learningAllowed === true
      }
    : null;
  const version = input ? expectedVersion : inputOrVersion;
  return command(withVersion({
    type: "actions.complete",
    id: requiredId(id, "行动 ID"),
    ...(input ? { input } : {})
  }, version));
};

export const buildUndoActionCompletionCommand = (id, expectedVersion) => command(withVersion({
  type: "actions.undoCompletion",
  id: requiredId(id, "行动 ID")
}, expectedVersion));

export const buildDeleteActionCommand = (id, expectedVersion) => command(withVersion({
  type: "actions.delete",
  id: requiredId(id, "行动 ID")
}, expectedVersion));

export const buildCreateHabitCommand = input => command({
  type: "habits.create",
  input: habitInput(input)
});

export const buildUpdateHabitCommand = (id, input, expectedVersion) => command(withVersion({
  type: "habits.update",
  id: requiredId(id, "习惯 ID"),
  input: habitInput(input, true)
}, expectedVersion));

export const buildSetHabitEnabledCommand = (id, enabled, expectedVersion) => {
  if (typeof enabled !== "boolean") throw new TypeError("习惯启停值必须是布尔值");
  return command(withVersion({
    type: "habits.setEnabled",
    id: requiredId(id, "习惯 ID"),
    enabled
  }, expectedVersion));
};

export const buildHabitAdjustmentCommand = (id, input, expectedVersion) => command(withVersion({
  type: "habits.recordAdjustment",
  id: requiredId(id, "习惯 ID"),
  input: {
    note: text(input?.note ?? input?.adjustment),
    ...(Object.hasOwn(input || {}, "frequency") ? { frequency: copy(input.frequency) } : {})
  }
}, expectedVersion));

export const buildHabitCheckinCommand = (habitId, input = {}) => command({
  type: "habitCheckins.create",
  habitId: requiredId(habitId, "习惯 ID"),
  input: checkinInput(input)
});

export const buildUpdateHabitCheckinCommand = (id, input, expectedVersion) => command(withVersion({
  type: "habitCheckins.update",
  id: requiredId(id, "习惯打卡 ID"),
  input: checkinInput(input)
}, expectedVersion));

export const buildDeleteHabitCommand = (id, expectedVersion) => command(withVersion({
  type: "habits.delete",
  id: requiredId(id, "习惯 ID")
}, expectedVersion));

export const buildDeleteHabitCheckinCommand = (id, expectedVersion) => command(withVersion({
  type: "habitCheckins.delete",
  id: requiredId(id, "习惯打卡 ID")
}, expectedVersion));

export const actionCommandBuilders = Object.freeze({
  createAction: buildCreateActionCommand,
  updateAction: buildUpdateActionCommand,
  setActionStatus: buildSetActionStatusCommand,
  completeAction: buildCompleteActionCommand,
  undoActionCompletion: buildUndoActionCompletionCommand,
  deleteAction: buildDeleteActionCommand,
  createHabit: buildCreateHabitCommand,
  updateHabit: buildUpdateHabitCommand,
  setHabitEnabled: buildSetHabitEnabledCommand,
  recordHabitAdjustment: buildHabitAdjustmentCommand,
  checkInHabit: buildHabitCheckinCommand,
  updateHabitCheckin: buildUpdateHabitCheckinCommand,
  deleteHabit: buildDeleteHabitCommand,
  deleteHabitCheckin: buildDeleteHabitCheckinCommand
});

export const ACTIONS_ENDPOINT = "/api/v1/actions";
export const HABITS_ENDPOINT = "/api/v1/habits";
export const HABIT_CHECKINS_ENDPOINT = "/api/v1/habit-checkins";

const EMPTY_ACTIONS_DATA={actions:[],habits:[],habitCheckins:[]};
const ACTION_CREATE_COMMANDS = new Set(["actions.create", "habits.create", "habitCheckins.create"]);
function actionsDependency(value,name){if(typeof value!=="function")throw new TypeError(`Actions coordinator requires ${name}`);return value}
function actionsList(value){return Array.isArray(value)?value:Array.isArray(value?.data)?value.data:[]}
function actionsDateKey(value){return(value instanceof Date?value.toISOString():String(value??"")).slice(0,10)}

function actionCommandRequest(pendingCommand) {
  const id=encodeURIComponent(pendingCommand.id||""),habitId=encodeURIComponent(pendingCommand.habitId||""),request={
    "actions.create": [ACTIONS_ENDPOINT, "POST", pendingCommand.input],
    "actions.update": [`${ACTIONS_ENDPOINT}/${id}`, "PATCH", pendingCommand.input],
    "actions.setStatus": [`${ACTIONS_ENDPOINT}/${id}`, "PATCH", { status: pendingCommand.status }],
    "actions.complete": [
      `${ACTIONS_ENDPOINT}/${id}/complete`,
      "POST",
      pendingCommand.input
    ],
    "actions.undoCompletion": [`${ACTIONS_ENDPOINT}/${id}/reopen`, "POST"],
    "actions.delete": [`${ACTIONS_ENDPOINT}/${id}`, "DELETE"],
    "habits.create": [HABITS_ENDPOINT, "POST", pendingCommand.input],
    "habits.update": [`${HABITS_ENDPOINT}/${id}`, "PATCH", pendingCommand.input],
    "habits.setEnabled": [`${HABITS_ENDPOINT}/${id}`, "PATCH", { status: pendingCommand.enabled ? "active" : "paused" }],
    "habits.recordAdjustment": [`${HABITS_ENDPOINT}/${id}/adjustments`, "POST", pendingCommand.input],
    "habits.delete": [`${HABITS_ENDPOINT}/${id}`, "DELETE"],
    "habitCheckins.create": [`${HABITS_ENDPOINT}/${habitId}/checkins`, "POST", pendingCommand.input],
    "habitCheckins.update": [`${HABIT_CHECKINS_ENDPOINT}/${id}`, "PATCH", pendingCommand.input],
    "habitCheckins.delete": [`${HABIT_CHECKINS_ENDPOINT}/${id}`, "DELETE"]
  }[pendingCommand.type];
  if (!request) throw new Error("暂不支持这个行动操作");
  const[path,method,body]=request;
  return{path,options:{method,headers:{},...(body===undefined?{}:{body:JSON.stringify(body)})}}
}

function actionCommandResource(pendingCommand, data) {
  if(String(pendingCommand.type||"").startsWith("actions."))return`action:${pendingCommand.id||"collection"}`;
  if(String(pendingCommand.type||"").startsWith("habits."))return`habit:${pendingCommand.id||"collection"}`;
  const checkin=data.habitCheckins.find(item=>item.id===pendingCommand.id);
  return`habit:${pendingCommand.habitId||checkin?.habitId||pendingCommand.id||"checkins"}`
}

const CONFIRMABLE_PROJECTIONS=new Set(["actions.update","actions.setStatus","actions.complete","actions.undoCompletion","actions.delete","habits.setEnabled","habits.recordAdjustment","habits.delete","habitCheckins.delete"]);
function projectionConfirmed(entry,value,domain){
  const type=entry.command.type;
  if(!CONFIRMABLE_PROJECTIONS.has(type)||(type==="habits.recordAdjustment"&&!entry.command.input?.frequency))return false;
  const clean=items=>items.map(({_sync,...item})=>item),projected=projectActionCommand(value,entry.command).value[domain];
  return JSON.stringify(clean(projected))===JSON.stringify(value[domain])
}

function actionConflictMessage(pendingCommand, error, data) {
  const action=String(pendingCommand.type||"").startsWith("actions.")?data.actions.find(item=>item.id===pendingCommand.id):null,habit=String(pendingCommand.type||"").startsWith("habits.")?data.habits.find(item=>item.id===pendingCommand.id):null,localVersion=pendingCommand.expectedVersion||"未知",serverVersion=error?.details?.currentVersion||action?.version||habit?.version||"未知";
  let local="这次操作",server="";
  if(pendingCommand.type==="actions.update")local=`标题“${pendingCommand.input.title}”、优先级 ${pendingCommand.input.priority}`;
  else if(pendingCommand.type==="actions.setStatus")local=`状态 ${pendingCommand.status}`;
  else if(pendingCommand.type==="actions.complete")local="完成行动";
  else if(pendingCommand.type==="actions.undoCompletion")local="撤销完成";
  else if(pendingCommand.type==="actions.delete")local="删除行动";
  else if(pendingCommand.type==="habits.setEnabled")local=pendingCommand.enabled?"启用习惯":"暂停习惯";
  else if(pendingCommand.type==="habits.recordAdjustment")local=`频次 ${pendingCommand.input.frequency?.cadence||"未指定"} / ${pendingCommand.input.frequency?.target||"未指定"}`;
  else if(pendingCommand.type==="habits.delete")local="删除习惯";
  if(action)server=`；服务器内容为“${action.title}”，状态 ${action.status}，优先级 ${action.priority}`;
  if(habit)server=`；服务器内容为“${habit.title}”，状态 ${habit.status}，频次 ${habit.frequency?.cadence||"未指定"} / ${habit.frequency?.target||"未指定"}`;
  return`同步冲突：你基于版本 ${localVersion} 提交了${local}；服务器当前为版本 ${serverVersion}${server}。列表已刷新，请核对后重试。`
}

export function createActionsCoordinator(deps = {}) {
  const session=deps.session||{},listAllV1=actionsDependency(deps.listAllV1,"listAllV1"),requestV1=actionsDependency(deps.requestV1,"requestV1"),captureSession=actionsDependency(deps.captureSession||deps.sessionCapture||session.capture?.bind(session),"session.capture"),isCurrentSession=actionsDependency(deps.isCurrentSession||session.isCurrent?.bind(session),"session.isCurrent"),currentDate=actionsDependency(deps.date,"date"),createId=actionsDependency(deps.id,"id"),clone=actionsDependency(deps.clone,"clone");
  let generation=0,loadSerial=0,loadTicket=null,latestLoadPromise=Promise.resolve(true),refreshTail=Promise.resolve(true),revision=0,base=clone(EMPTY_ACTIONS_DATA),visible=clone(EMPTY_ACTIONS_DATA),loadState="idle",loadError="";
  const domainRevisions={actions:0,habits:0,habitCheckins:0};
  const projections=new Map(),subscribers=new Set();
  const snapshot=()=>clone({...visible,today:actionsDateKey(currentDate()),loadState,loadError,revision});
  const publish=detail=>{revision+=1;const value=snapshot();for(const listener of subscribers)listener(value,detail)};
  const capture=extra=>({generation,session:captureSession(),...extra});
  const isCurrent=ticket=>ticket?.generation === generation&&isCurrentSession(ticket.session);
  const rebuild = () => {
    let next=clone(base);
    for(const entry of projections.values())next=projectActionCommand(next,entry.command,{status:entry.status,operationId:entry.operationId,createdAt:entry.createdAt}).value;
    visible=next
  };
  const setProjection = (operationId, pendingCommand, record = {}) => {
    const key=String(operationId||"");if(!key)return false;
    const domains=pendingCommand.type==="habits.delete"?["habits","habitCheckins"]:[pendingCommand.type.split(".")[0]];
    projections.set(key,{operationId:key,command:clone(pendingCommand),domains,confirmed:new Set,serial:loadSerial,status:["pending","committed"].includes(record.status)?record.status:"sending",createdAt:String(record.createdAt||"")});
    rebuild();publish({type:"projection",operationId:key});return true
  };
  const removeProjection = operationId => {
    const key=String(operationId||"");if(!key||!projections.delete(key))return false;
    rebuild();publish({type:"projection-removed",operationId:key});return true
  };

  async function performLoad() {
    const ticket=capture({serial:++loadSerial,domainRevisions:{...domainRevisions}}),options=ticket.session?.signal?{signal:ticket.session.signal}:{};
    loadTicket=ticket;loadState="loading";loadError="";publish({type:"load",status:"loading"});
    try {
      const[actionsResult,habitsResult]=await Promise.all([listAllV1(ACTIONS_ENDPOINT,options),listAllV1(HABITS_ENDPOINT,options)]);
      if(!isCurrent(ticket)||ticket.serial!==loadSerial)return false;
      const actions=actionsList(actionsResult),habits=actionsList(habitsResult),checkins=(await Promise.all(habits.map(habit=>listAllV1(`${HABITS_ENDPOINT}/${encodeURIComponent(habit.id)}/checkins`,options).then(actionsList)))).flat();
      if(!isCurrent(ticket)||ticket.serial!==loadSerial)return false;
      const incoming={actions,habits,habitCheckins:checkins},accepted=domain=>ticket.domainRevisions[domain]===domainRevisions[domain];
      base=clone(Object.fromEntries(Object.keys(incoming).map(domain=>[domain,accepted(domain)?incoming[domain]:base[domain]])));
      for(const[operationId,entry]of projections)if(entry.status==="committed"&&entry.serial<ticket.serial&&entry.domains.every(accepted))projections.delete(operationId);
      rebuild();loadState="ready";loadError="";publish({type:"load",status:"ready"});return true
    } catch (error) {
      if(!isCurrent(ticket)||ticket.serial!==loadSerial)return false;
      loadState="failure";loadError=error?.message||"行动列表刷新失败";publish({type:"load",status:"failure",error});return false
    }
  }
  const load=({ensure=false}={})=>ensure&&loadTicket&&isCurrent(loadTicket)&&["loading","ready"].includes(loadState)?loadState==="loading"?latestLoadPromise:Promise.resolve(true):latestLoadPromise=performLoad();
  const refreshData=ticket=>(refreshTail=refreshTail.then(async()=>{if(ticket&&!isCurrent(ticket))return false;let operation=load();for(;;){const result=await operation;if(ticket&&!isCurrent(ticket))return false;if(latestLoadPromise===operation)return result;operation=latestLoadPromise}}));

  const applyPendingRecord=(record={})=>record?.projection?.kind==="action.command"&&record.projection.command?setProjection(record.operationId,record.projection.command,record):false;
  const applyOperationStatus=(record={})=>{const operationId=String(record.operationId||""),entry=projections.get(operationId);if(!entry)return false;if(["failed","conflict"].includes(record.status))return removeProjection(operationId);if(!["pending","sending","committed"].includes(record.status))return false;entry.status=record.status;entry.serial=loadSerial;rebuild();publish({type:"operation",operationId,status:record.status});return true};

  function applyIncrementalSnapshot(value = {}, options = {}) {
    if(options.sessionTicket&&!isCurrentSession(options.sessionTicket))return false;
    const domains=["actions","habits","habitCheckins"],changed=domains.filter(domain=>Array.isArray(value?.[domain]));if(!changed.length)return false;
    base=clone({actions:changed.includes("actions")?value.actions:base.actions,habits:changed.includes("habits")?value.habits:base.habits,habitCheckins:changed.includes("habitCheckins")?value.habitCheckins:base.habitCheckins});for(const domain of changed)domainRevisions[domain]+=1;
    for(const[operationId,entry]of projections)if(entry.status==="committed"){for(const domain of entry.domains)if(changed.includes(domain))entry.confirmed[projectionConfirmed(entry,value,domain)?"add":"delete"](domain);if(entry.domains.every(domain=>entry.confirmed.has(domain)))projections.delete(operationId)}
    rebuild();loadState="ready";loadError="";publish({type:"incremental",domains:changed});return true
  }

  async function runCommand(pendingCommand, { idempotencyKey = "" } = {}) {
    if(!pendingCommand||typeof pendingCommand!=="object")throw new TypeError("行动命令不能为空");
    const ticket=capture({}),request=actionCommandRequest(pendingCommand);if(pendingCommand.expectedVersion)request.options.headers["if-match"]=`"${pendingCommand.expectedVersion}"`;
    let requestId=String(idempotencyKey||"");if(ACTION_CREATE_COMMANDS.has(pendingCommand.type)){requestId||=String(createId()||"");if(!requestId)throw new TypeError("无法创建行动请求标识");request.options.headers["idempotency-key"]=requestId}
    let operationId="";
    const applyQueued=record=>{if(!isCurrent(ticket))return false;operationId=String(record?.operationId||operationId||requestId);return setProjection(operationId,pendingCommand,{...record,status:"sending"})};
    let result;
    try {
      result=await requestV1(request.path,request.options,{resource:actionCommandResource(pendingCommand,visible),domains:["actions","habits","habitCheckins"],recoverCommitted:true,projection:{kind:"action.command",command:clone(pendingCommand)},onQueued:applyQueued});
    } catch (error) {
      if(!isCurrent(ticket))return false;
      if([409,412].includes(Number(error?.status))){
        if(operationId)removeProjection(operationId);await refreshData(ticket);if(!isCurrent(ticket))return false;
        throw Object.assign(new Error(actionConflictMessage(pendingCommand,error,visible)),{status:error.status,code:error.code,details:error.details})
      }
      if(error?.syncStatus==="pending"){
        if(operationId)setProjection(operationId,pendingCommand,{status:"pending",createdAt:projections.get(operationId)?.createdAt});
        throw Object.assign(new Error("已更新，网络恢复后自动同步。"),{syncStatus:"pending"})
      }
      if(operationId)removeProjection(operationId);throw error
    }
    if(!isCurrent(ticket))return false;
    if(operationId)setProjection(operationId,pendingCommand,{status:"committed",createdAt:projections.get(operationId)?.createdAt});
    const refreshed=await refreshData(ticket);if(!isCurrent(ticket))return false;
    if(!refreshed)throw Object.assign(new Error("已保存，但行动列表刷新失败，请稍后重试同步。"),{saved:true});
    return result
  }

  function resetSession() {
    generation+=1;loadTicket=null;latestLoadPromise=Promise.resolve(true);refreshTail=Promise.resolve(true);base=clone(EMPTY_ACTIONS_DATA);visible=clone(EMPTY_ACTIONS_DATA);loadState="idle";loadError="";for(const domain of Object.keys(domainRevisions))domainRevisions[domain]=0;projections.clear();publish({type:"reset"})
  }

  function subscribe(listener) {
    if(typeof listener!=="function")throw new TypeError("Actions coordinator subscriber must be a function");
    subscribers.add(listener);listener(snapshot(),{type:"subscribe"});let active=true;
    return()=>{if(!active)return;active=false;subscribers.delete(listener)}
  }

  return Object.freeze({snapshot,load,runCommand,applyPendingRecord,applyOperationStatus,applyIncrementalSnapshot,resetSession,subscribe,commands:actionCommandBuilders,createRequestId:()=>String(createId()||""),viewModel:value=>{const source=value||snapshot();return createActionsViewModel(source,{today:source.today})}});
}
