import { useMemo, useState } from "react";
import {
  ArrowRight,
  Books,
  FileText,
  MagnifyingGlass,
  Plus,
  Tag,
} from "@phosphor-icons/react";
import { Button, Input } from "@tagent/ui";
import {
  workbenchHasTag,
  type KnowledgeBaseDocument,
  type KnowledgeBaseRecord,
} from "@tagent/shared";
import { kindLabel } from "./kb-document-templates";

export const documentExcerpt = (content: string) =>
  content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .slice(0, 150);
export const knowledgeDate = (time: number) =>
  new Date(time).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });

export function knowledgeTopicCounts(
  documents: KnowledgeBaseDocument[],
): [string, number][] {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const topics = new Set(
      (document.tags ?? []).flatMap((value) => {
        const parts = value.split("/");
        return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
      }),
    );
    for (const topic of topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function KnowledgeLibrary({
  bases,
  documents,
  loading,
  onBase,
  onDocument,
  onCreate,
}: {
  bases: KnowledgeBaseRecord[];
  documents: KnowledgeBaseDocument[];
  loading: boolean;
  onBase: (id: string) => void;
  onDocument: (document: KnowledgeBaseDocument) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [limit, setLimit] = useState(12);
  const [allTags, setAllTags] = useState(false);
  const tags = useMemo(() => knowledgeTopicCounts(documents), [documents]);
  const filtered = documents
    .filter(
      (document) =>
        workbenchHasTag(document.tags, tag) &&
        `${document.title}\n${document.content}\n${(document.tags ?? []).join(" ")}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="kl-library">
      <aside className="kl-catalog" aria-label="知识分类">
        <div className="kl-catalog-heading">
          <h3>
            <Books size={16} />
            知识库
          </h3>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="新建知识库"
            onClick={onCreate}
          >
            <Plus />
          </Button>
        </div>
        <p className="kl-description">按主题存放长期积累的资料</p>
        <div className="kl-base-list">
          {bases.map((base) => (
            <Button
              key={base.id}
              variant="outline"
              className="kl-base-button"
              onClick={() => onBase(base.id)}
            >
              <Books />
              <span>{base.name}</span>
              <small>
                {
                  documents.filter((doc) => doc.knowledgeBaseId === base.id)
                    .length
                }
              </small>
              <ArrowRight />
            </Button>
          ))}
          {!bases.length && (
            <p className="kl-description">还没有知识库，先创建一个开始积累。</p>
          )}
        </div>
        <div className="kl-catalog-heading kl-topics-heading">
          <h3>
            <Tag size={16} />
            主题标签
          </h3>
          {tag && (
            <Button size="sm" variant="outline" onClick={() => setTag("")}>
              清除
            </Button>
          )}
        </div>
        <div className="kl-topic-list">
          {tags.slice(0, allTags ? tags.length : 8).map(([value, count]) => (
            <button
              type="button"
              key={value}
              aria-pressed={tag === value}
              aria-label={`筛选知识标签：${value}`}
              onClick={() => {
                setTag(tag === value ? "" : value);
                setLimit(12);
              }}
            >
              <span>#{value}</span>
              <small>{count}</small>
              <i
                aria-hidden="true"
                style={{
                  width: `${(count / Math.max(1, tags[0]?.[1] ?? 1)) * 100}%`,
                }}
              />
            </button>
          ))}
          {!tags.length && (
            <p className="kl-description">
              整理和保存内容时添加标签，之后更容易找回。
            </p>
          )}
        </div>
        {tags.length > 8 && (
          <Button
            variant="outline"
            size="sm"
            className="kl-load-more"
            aria-expanded={allTags}
            onClick={() => setAllTags(!allTags)}
          >
            {allTags ? "收起标签" : `查看全部 ${tags.length} 个标签`}
          </Button>
        )}
      </aside>
      <section className="kl-documents" aria-label="全部知识文档">
        <div className="kl-library-toolbar">
          <div>
            <h3>{tag ? `#${tag}` : query ? "搜索结果" : "最近更新"}</h3>
            <p className="kl-description">
              {loading
                ? "正在读取文档…"
                : `${filtered.length} 篇文档${tag || query ? "符合筛选" : ` · ${bases.length} 个知识库`}`}
            </p>
          </div>
          <label className="kl-search">
            <MagnifyingGlass aria-hidden="true" size={16} />
            <Input
              type="search"
              aria-label="搜索全部知识"
              placeholder="搜索标题、正文或标签"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(12);
              }}
            />
          </label>
        </div>
        {loading ? (
          <p role="status" className="kl-empty">
            正在加载知识内容…
          </p>
        ) : !filtered.length ? (
          <div className="kl-empty">
            <FileText size={32} />
            <h3>
              {documents.length
                ? "没有找到匹配的知识"
                : "让零散记录成为可复用的知识"}
            </h3>
            <p>
              {documents.length
                ? "试试其他关键词，或清除标签筛选。"
                : "在收集中整理笔记后选择“入知识库”，也可以在知识库里直接新建或导入文档。"}
            </p>
            {documents.length ? (
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setTag("");
                }}
              >
                清除筛选
              </Button>
            ) : (
              <Button onClick={onCreate}>
                <Plus />
                新建知识库
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="kl-document-grid">
              {filtered.slice(0, limit).map((document) => (
                <button
                  type="button"
                  key={document.id}
                  className="kl-document-card"
                  onClick={() => onDocument(document)}
                  aria-label={`阅读：${document.title}`}
                >
                  <span className="kl-card-meta">
                    <span>
                      <FileText size={15} />
                      {kindLabel(document.kind)}
                    </span>
                    <time dateTime={new Date(document.updatedAt).toISOString()}>
                      {knowledgeDate(document.updatedAt)}
                    </time>
                  </span>
                  <strong>{document.title}</strong>
                  <p>
                    {documentExcerpt(document.content) ||
                      "还没有正文，打开后继续编辑。"}
                  </p>
                  <span className="kl-card-tags">
                    {document.tags?.slice(0, 3).map((value) => (
                      <span key={value}>#{value}</span>
                    ))}
                  </span>
                  <span className="kl-card-footer">
                    <span>
                      {bases.find(
                        (base) => base.id === document.knowledgeBaseId,
                      )?.name ?? "知识库"}
                    </span>
                    <span>
                      阅读文档 <ArrowRight size={14} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {filtered.length > limit && (
              <Button
                variant="outline"
                className="kl-load-more"
                onClick={() => setLimit(limit + 12)}
              >
                再看 12 篇
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
