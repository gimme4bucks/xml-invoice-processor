/** A timestamp from the API in the browser's locale; the ISO value stays in `<time dateTime>`. */
export function formatTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
}
