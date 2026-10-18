const invalidData = () => Object.assign(
  new Error("任务通知关系异常，原数据已保留"),
  { statusCode: 503, code: "ACCOUNT_DATA_INVALID" }
);

export async function readTaskNotification(ports, taskRow) {
  const keys = await ports.relations.findSources([taskRow.objectKey], {
    relation: "task",
    sourceCollection: "notifications"
  });
  if (keys.length > 1) throw invalidData();
  const rows = await ports.objects.findMany(keys, { lock: true });
  if (rows.some(row => row.payload?.taskId !== taskRow.id)) throw invalidData();
  return rows[0] || null;
}
