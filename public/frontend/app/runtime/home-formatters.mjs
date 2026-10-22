export function shiftLocalDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const shiftedDate = new Date(Date.UTC(year, month - 1, day + days));
  return shiftedDate.toISOString().slice(0, 10);
}

export const compactNumber = value => new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1
}).format(Number(value) || 0);

export function formatCny(value) {
  const number = Number(value) || 0;
  const absolute = Math.abs(number);
  let digits = 6;
  if (absolute === 0) digits = 2;
  else if (absolute >= 100) digits = 0;
  else if (absolute >= 10) digits = 1;
  else if (absolute >= 1) digits = 2;
  else if (absolute >= 0.1) digits = 3;
  else if (absolute >= 0.01) digits = 4;
  return `${number < 0 ? "-" : ""}¥${absolute.toFixed(digits)}`;
}

export function formatDuration(value) {
  const milliseconds = Number(value) || 0;
  if (milliseconds >= 60000) return `${(milliseconds / 60000).toFixed(1)} 分钟`;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  return `${Math.round(milliseconds)} ms`;
}
