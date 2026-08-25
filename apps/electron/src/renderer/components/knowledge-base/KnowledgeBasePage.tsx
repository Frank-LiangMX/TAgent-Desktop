import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  Books,
  CheckCircle,
  FileArrowUp,
  FileText,
  FolderOpen,
  LinkSimple,
  MagnifyingGlass,
  Plus,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type {
  KnowledgeBaseDocument,
  KnowledgeBaseRecord,
} from "@tagent/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@tagent/ui";
import { cn } from "../../lib/utils";
import { browserApi } from "../../atoms/browser";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function extractHttpUrl(raw: string): string {
  const embedded = raw.match(/https?:\/\/[^\s<>{}\]\)]+/i)?.[0];
  return (embedded ?? raw.trim()).replace(/[),.;!?，。；！？】》]+$/g, "");
}

const sourceProviderLabel = (provider: KnowledgeBaseDocument["sourceProvider"]): string => {
  switch (provider) {
    case "wps":
      return "WPS 云文档";
    case "feishu":
      return "飞书云文档";
    case "google-drive":
      return "Google 云文档";
    default:
      return "云文档";
  }
};

export function KnowledgeBasePage(): JSX.Element {
  const [items, setItems] = useState<KnowledgeBaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [paths, setPaths] = useState<string[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await window.electronAPI.listKnowledgeBases());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const choosePaths = async () => {
    const selectedPaths = await window.electronAPI.openFolderDialog();
    if (selectedPaths.length)
      setPaths((current) => [...new Set([...current, ...selectedPaths])]);
  };
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await window.electronAPI.createKnowledgeBase({
        name: name.trim(),
        description: description.trim() || undefined,
        sourcePaths: paths,
      });
      setItems((current) => [created, ...current]);
      setDialogOpen(false);
      setName("");
      setDescription("");
      setPaths([]);
      setSelectedId(created.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const addSource = async (id: string) => {
    const selectedPaths = await window.electronAPI.openFolderDialog();
    if (!selectedPaths[0]) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await window.electronAPI.addKnowledgeBaseSource({
        id,
        path: selectedPaths[0],
      });
      setItems((current) =>
        current.map((item) => (item.id === id ? updated : item)),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const removeSource = async (id: string, sourceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.electronAPI.removeKnowledgeBaseSource({
        id,
        sourceId,
      });
      setItems((current) =>
        current.map((item) => (item.id === id ? updated : item)),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (item: KnowledgeBaseRecord) => {
    if (
      !window.confirm(
        "删除知识库「" +
          item.name +
          "」？文档和本地来源都不会保留在应用配置中，本地文件不会被删除。",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.deleteKnowledgeBase(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      if (selectedId === item.id) setSelectedId(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (selected) {
    return (
      <KnowledgeBaseDetail
        item={selected}
        busy={busy}
        error={error}
        onBack={() => setSelectedId(null)}
        onError={setError}
        onAddSource={() => void addSource(selected.id)}
        onRemoveSource={(sourceId) => void removeSource(selected.id, sourceId)}
        onDelete={() => void remove(selected)}
      />
    );
  }

  return (
    <main className="app-shell-content-stage h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-primary">
              <Books size={22} weight="duotone" />
              <span className="text-xs font-medium uppercase tracking-[0.18em]">
                Knowledge
              </span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">知识库</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              创建可跨项目复用的知识集合。知识库的主体是文档，目录只是可选来源。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void reload()}
              disabled={loading || busy}
              aria-label="刷新知识库"
            >
              <ArrowClockwise
                size={16}
                className={cn(loading && "animate-spin")}
              />
            </Button>
            <Button onClick={() => setDialogOpen(true)} disabled={busy}>
              <Plus size={16} weight="bold" />
              新建知识库
            </Button>
          </div>
        </header>
        {error && <ErrorBanner message={error} />}
        {loading ? (
          <div className="rounded-2xl border bg-card/50 px-5 py-12 text-center text-sm text-muted-foreground">
            正在加载知识库…
          </div>
        ) : items.length === 0 ? (
          <section className="rounded-2xl border border-dashed bg-card/40 px-6 py-16 text-center">
            <Books
              size={38}
              className="mx-auto mb-4 text-muted-foreground/60"
            />
            <h2 className="text-base font-medium">还没有知识库</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              先创建一个知识库，然后直接新建文档、导入资料或让 Agent
              整理后保存。
            </p>
            <Button className="mt-5" onClick={() => setDialogOpen(true)}>
              <Plus size={16} weight="bold" />
              创建第一个知识库
            </Button>
          </section>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {items.map((item) => (
              <article
                key={item.id}
                className="rounded-2xl border bg-card/60 p-5 shadow-sm"
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold">
                        {item.name}
                      </h2>
                      <p className="mt-1 min-h-5 text-sm text-muted-foreground">
                        {item.description || "暂无描述"}
                      </p>
                    </div>
                    <span className="rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                      打开
                    </span>
                  </div>
                  <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                    <FileText size={17} />
                    进入知识库详情，管理文档
                  </div>
                </button>
                <div className="mt-4 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                  <span>{item.sources.length} 个目录来源</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(item)}
                    disabled={busy}
                    aria-label={"删除知识库 " + item.name}
                  >
                    <Trash size={16} />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="mt-6 text-xs text-muted-foreground">
          阅读资料不会自动入库；只有明确保存的内容才会成为知识文档。
        </p>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新建知识库</DialogTitle>
          <DialogDescription>
            知识库不绑定项目。创建后可以直接新建文档，也可以添加外部目录作为检索来源。
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">名称</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：产品设计规范"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">描述（可选）</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="这套知识主要用于什么场景？"
                className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">外部目录（可选）</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仅作为来源，不会复制或删除本地文件。
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void choosePaths()}
                >
                  <FolderOpen size={15} />
                  选择目录
                </Button>
              </div>
              {paths.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {paths.map((path) => (
                    <li
                      key={path}
                      className="flex gap-2 text-xs text-muted-foreground"
                    >
                      <CheckCircle
                        size={14}
                        className="text-emerald-600"
                        weight="fill"
                      />
                      <span className="truncate" title={path}>
                        {path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
              >
                取消
              </Button>
              <Button
                onClick={() => void create()}
                disabled={busy || !name.trim()}
              >
                {busy ? "创建中…" : "创建知识库"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <div
      className="mb-5 flex gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      <WarningCircle size={18} />
      <span>{message}</span>
    </div>
  );
}

function KnowledgeBaseDetail({
  item,
  busy,
  error,
  onBack,
  onError,
  onAddSource,
  onRemoveSource,
  onDelete,
}: {
  item: KnowledgeBaseRecord;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onError: (message: string | null) => void;
  onAddSource: () => void;
  onRemoveSource: (sourceId: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [documents, setDocuments] = useState<KnowledgeBaseDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteTitle, setRemoteTitle] = useState("");
  const [browserImportOpened, setBrowserImportOpened] = useState(false);
  const browserImportSessionId = "knowledge-base-import-" + item.id;

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      setDocuments(
        await window.electronAPI.listKnowledgeBaseDocuments({
          knowledgeBaseId: item.id,
        }),
      );
    } catch (e) {
      onError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [item.id, onError]);
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);
  const visible = useMemo(() => {
    const value = query.trim().toLowerCase();
    return value
      ? documents.filter(
          (doc) =>
            doc.title.toLowerCase().includes(value) ||
            doc.content.toLowerCase().includes(value),
        )
      : documents;
  }, [documents, query]);
  const active = documents.find((doc) => doc.id === activeId) ?? null;
  useEffect(() => {
    setEditorTitle(active?.title ?? "");
    setEditorContent(active?.content ?? "");
  }, [activeId, active?.content, active?.title]);

  const newDocument = async () => {
    setSaving(true);
    onError(null);
    try {
      const created = await window.electronAPI.createKnowledgeBaseDocument({
        knowledgeBaseId: item.id,
        title: "未命名文档",
        content: "# 未命名文档\n\n",
      });
      setDocuments((current) => [created, ...current]);
      setActiveId(created.id);
      setMode("edit");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const importDocument = async () => {
    setSaving(true);
    onError(null);
    try {
      const imported = await window.electronAPI.importKnowledgeBaseDocument({
        knowledgeBaseId: item.id,
      });
      if (!imported) return;
      setDocuments((current) => [imported, ...current]);
      setActiveId(imported.id);
      setMode("preview");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const openRemoteInBrowser = async () => {
    const url = extractHttpUrl(remoteUrl);
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      onError("没有找到完整的 http(s) 云文档地址");
      return;
    }
    onError(null);
    try {
      await browserApi().browserOpenWindow({
        sessionId: browserImportSessionId,
        url,
        title: "云文档导入",
      });
      setRemoteUrl(url);
      setBrowserImportOpened(true);
    } catch (e) {
      onError(errorText(e));
    }
  };
  const importBrowserPage = async () => {
    setSaving(true);
    onError(null);
    try {
      const page = await browserApi().browserExtractWindowText(browserImportSessionId);
      const content = page.text.trim();
      if (content.length < 40) {
        throw new Error("当前网页正文太短，请先在内置浏览器中完成登录并打开文档正文");
      }
      const imported = await window.electronAPI.createKnowledgeBaseDocument({
        knowledgeBaseId: item.id,
        title: remoteTitle.trim() || page.title || "网页文档",
        content,
        sourceUrl: page.url,
        sourceProvider: "unknown",
        sourceAccessMode: "browser",
        sourceSyncedAt: Date.now(),
      });
      setDocuments((current) => [imported, ...current]);
      setActiveId(imported.id);
      setMode("preview");
      setUrlDialogOpen(false);
      setRemoteUrl("");
      setRemoteTitle("");
      setBrowserImportOpened(false);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!active) return;
    setSaving(true);
    onError(null);
    try {
      const updated = await window.electronAPI.updateKnowledgeBaseDocument({
        id: active.id,
        title: editorTitle,
        content: editorContent,
      });
      setDocuments((current) =>
        current.map((doc) => (doc.id === updated.id ? updated : doc)),
      );
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!active || !window.confirm("删除文档「" + active.title + "」？"))
      return;
    setSaving(true);
    onError(null);
    try {
      await window.electronAPI.deleteKnowledgeBaseDocument(active.id);
      setDocuments((current) => current.filter((doc) => doc.id !== active.id));
      setActiveId(null);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="app-shell-content-stage h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-7">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 mb-2 gap-1.5"
              onClick={onBack}
            >
              <ArrowLeft size={15} />
              返回知识库
            </Button>
            <div className="flex items-center gap-2">
              <Books size={22} className="text-primary" weight="duotone" />
              <h1 className="truncate text-2xl font-semibold">{item.name}</h1>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {item.description || "把确认过的知识整理成可复用文档。"}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onAddSource}
              disabled={busy}
            >
              <FolderOpen size={15} />
              添加来源
            </Button>
            <Button
              variant="outline"
              onClick={() => setUrlDialogOpen(true)}
              disabled={saving}
            >
              <LinkSimple size={16} />
              打开云文档
            </Button>
            <Button
              variant="outline"
              onClick={() => void importDocument()}
              disabled={saving}
            >
              <FileArrowUp size={16} />
              导入文档
            </Button>
            <Button onClick={() => void newDocument()} disabled={saving}>
              <Plus size={16} weight="bold" />
              新建文档
            </Button>
          </div>
        </header>
        {error && <ErrorBanner message={error} />}
        <div className="grid min-h-[520px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="rounded-2xl border bg-card/50 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileText size={17} />
                文档
              </div>
              <span className="text-xs text-muted-foreground">
                {documents.length}
              </span>
            </div>
            <label className="relative block">
              <MagnifyingGlass
                size={15}
                className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索文档"
                className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <div className="mt-3 space-y-1.5">
              {loading ? (
                <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                  正在加载…
                </p>
              ) : visible.length === 0 ? (
                <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                  还没有文档，点击上方新建。
                </p>
              ) : (
                visible.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left hover:bg-accent",
                      activeId === doc.id && "bg-primary/10 text-primary",
                    )}
                    onClick={() => {
                      setActiveId(doc.id);
                      setMode("edit");
                    }}
                  >
                    <span className="block truncate text-sm">{doc.title}</span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {doc.content.replace(/\s+/g, " ").slice(0, 60) ||
                        "空文档"}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="mt-5 border-t pt-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                来源目录
              </p>
              {item.sources.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无外部来源</p>
              ) : (
                <ul className="space-y-1.5">
                  {item.sources.map((source) => (
                    <li
                      key={source.id}
                      className="flex items-center gap-2 text-xs"
                    >
                      <FolderOpen
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={source.path}
                      >
                        {source.label}
                      </span>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:bg-background"
                        onClick={() => onRemoveSource(source.id)}
                        disabled={busy}
                        aria-label={"移除来源 " + source.label}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-start gap-2 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              disabled={busy}
            >
              <Trash size={15} />
              删除知识库
            </Button>
          </aside>
          <section className="flex min-h-[520px] flex-col rounded-2xl border bg-card/50">
            {active ? (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
                  <input
                    value={editorTitle}
                    onChange={(e) => setEditorTitle(e.target.value)}
                    className="min-w-[220px] flex-1 bg-transparent text-base font-semibold outline-none"
                    aria-label="文档标题"
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      variant={mode === "edit" ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setMode("edit")}
                    >
                      编辑
                    </Button>
                    <Button
                      variant={mode === "preview" ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setMode("preview")}
                    >
                      预览
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void save()}
                      disabled={saving || !editorTitle.trim()}
                    >
                      {saving ? "保存中…" : "保存"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void remove()}
                      disabled={saving}
                      aria-label="删除文档"
                    >
                      <Trash size={16} />
                    </Button>
                  </div>
                </div>
                {active.sourceUrl && (
                  <div className="mx-5 mb-2 space-y-1">
                    <a
                      href={active.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-xs text-primary hover:underline"
                      title={active.sourceUrl}
                    >
                      来源：{active.sourceUrl}
                    </a>
                    {(active.sourceProvider || active.sourceSyncedAt) && (
                      <p className="text-[11px] text-muted-foreground">
                        {active.sourceProvider
                          ? sourceProviderLabel(active.sourceProvider)
                          : "云文档"}
                        {active.sourceSyncedAt
                          ? ` · 快照于 ${new Date(active.sourceSyncedAt).toLocaleString()}`
                          : ""}
                        {active.sourceExternalId
                          ? ` · 文档 ID：${active.sourceExternalId}`
                          : ""}
                      </p>
                    )}
                  </div>
                )}
                {mode === "edit" ? (
                  <textarea
                    value={editorContent}
                    onChange={(e) => setEditorContent(e.target.value)}
                    className="min-h-[430px] flex-1 resize-none bg-transparent px-5 py-4 font-mono text-sm leading-6 outline-none"
                    aria-label="文档内容"
                    placeholder="在这里写下确认过的知识…"
                  />
                ) : (
                  <article className="min-h-[430px] flex-1 whitespace-pre-wrap px-5 py-4 text-sm leading-7">
                    {editorContent || "空文档"}
                  </article>
                )}
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <FileText size={35} className="mb-4 text-muted-foreground/60" />
                <h2 className="text-base font-medium">选择或创建一篇文档</h2>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  阅读资料时不必立即入库；整理完成并确认后，再把内容保存为正式文档。
                </p>
                <Button
                  className="mt-5"
                  onClick={() => void newDocument()}
                  disabled={saving}
                >
                  <Plus size={16} weight="bold" />
                  新建文档
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void importDocument()}
                  disabled={saving}
                >
                  <FileArrowUp size={16} />
                  导入本地文档
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
      <Dialog
        open={urlDialogOpen}
        onOpenChange={setUrlDialogOpen}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>导入云文档</DialogTitle>
          <DialogDescription>
            在独立的 TAgent 浏览器窗口中打开文档。你可以在完整窗口中登录、扫码并打开正文。
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">文档地址</span>
              <input
                autoFocus
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(extractHttpUrl(e.target.value))}
                placeholder="可粘贴标题 + Markdown 链接"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">标题（可选）</span>
              <input
                value={remoteTitle}
                onChange={(e) => setRemoteTitle(e.target.value)}
                placeholder="不填则使用网页标题"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            {browserImportOpened && (
              <p className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
                已在独立浏览器窗口打开。完成登录并进入文档正文后，回到这里点击“读取当前网页”。
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setUrlDialogOpen(false)}
                disabled={saving}
              >
                关闭
              </Button>
              <Button
                variant="outline"
                onClick={() => void openRemoteInBrowser()}
                disabled={saving || !remoteUrl.trim()}
              >
                打开独立浏览器
              </Button>
              <Button
                onClick={() => void importBrowserPage()}
                disabled={saving || !browserImportOpened}
              >
                {saving ? "读取中…" : "读取当前网页"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
