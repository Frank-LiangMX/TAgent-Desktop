export function documentTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Use saved document timestamps, distinct from the date the report covers. */
export function DocumentTimestamps({
  createdAt,
  updatedAt,
}: {
  createdAt: number;
  updatedAt: number;
}) {
  return (
    <span className="wb-document-times">
      <span>
        生成于{" "}
        <time dateTime={new Date(createdAt).toISOString()}>
          {documentTimestamp(createdAt)}
        </time>
      </span>
      {updatedAt > createdAt && (
        <span>
          更新于{" "}
          <time dateTime={new Date(updatedAt).toISOString()}>
            {documentTimestamp(updatedAt)}
          </time>
        </span>
      )}
    </span>
  );
}
