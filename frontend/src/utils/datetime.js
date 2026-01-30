// 统一的时间格式化工具：按 UTC+8 显示为「YYYY年M月D日HH:mm:ss」
// 示例：2026年1月28日23:07:52

export function formatDateTimeUtc8(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  // 统一按「服务端给的是 UTC 时间」来处理：转换为UTC+8时间
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 不补 0
  const day = date.getUTCDate() + (date.getUTCHours() >= 16 ? 1 : 0); // 处理跨天情况
  const h = (date.getUTCHours() + 8) % 24; // 转换为UTC+8小时
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');

  return `${y}年${m}月${day}日${h}:${mi}:${s}`;
}

