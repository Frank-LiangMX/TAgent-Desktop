import { useCallback, useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import {
  ArrowClockwise,
  Books,
  CaretDown,
  CheckCircle,
  FileArrowUp,
  FileText,
  FolderOpen,
  LinkSimple,
  Trash,
  WarningCircle,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MessageResponse,
} from "@tagent/ui";
import { cn } from "../../lib/utils";
import { browserApi } from "../../atoms/browser";
import { knowledgeBaseSidebarAtom } from "../../atoms/knowledge-base";
import {
  BASE_BACK_EVENT,
  BASE_SELECT_EVENT,
  NEW_BASE_EVENT,
  DOCUMENT_SELECT_EVENT,
  NEW_DOCUMENT_EVENT,
  REMOVE_SOURCE_EVENT,
} from "./KnowledgeBaseSidebar";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function formatKnowledgeDate(timestamp: number): string {
  if (!timestamp) return "暂无";
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

function KnowledgeOverviewStat({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div className="border-r border-border/40 px-4 py-4 first:pl-0 last:border-r-0 md:px-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-[-0.02em]">{value}</p>
    </div>
  );
}
function extractHttpUrl(raw: string): string {
  const embedded = raw.match(/https?:\/\/[^\s<>{}\]\)]+/i)?.[0];
  return (embedded ?? raw.trim()).replace(/[),.;!?，。；！？】》]+$/g, "");
}

const sourceProviderLabel = (
  provider: KnowledgeBaseDocument["sourceProvider"],
): string => {
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
  const setSidebarState = useSetAtom(knowledgeBaseSidebarAtom);

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
  const [documentCount, setDocumentCount] = useState<number | null>(null);
  const [documentCountLoading, setDocumentCountLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (loading) {
      setDocumentCount(null);
      setDocumentCountLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (items.length === 0) {
      setDocumentCount(0);
      setDocumentCountLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setDocumentCountLoading(true);
    void Promise.all(
      items.map((item) =>
        window.electronAPI.listKnowledgeBaseDocuments({
          knowledgeBaseId: item.id,
        }),
      ),
    )
      .then((lists) => {
        if (!cancelled) {
          setDocumentCount(
            lists.reduce((total, list) => total + list.length, 0),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setDocumentCountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [items, loading]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const totalSourceCount = items.reduce(
    (total, item) => total + item.sources.length,
    0,
  );
  const latestUpdatedAt = items.reduce(
    (latest, item) => Math.max(latest, item.updatedAt),
    0,
  );
  useEffect(() => {
    if (selected) return;
    setSidebarState({ mode: "bases", items, selectedId, loading });
  }, [items, loading, selected, selectedId, setSidebarState]);
  useEffect(() => {
    const handleBaseSelect = (event: Event): void => {
      const knowledgeBaseId = (
        event as CustomEvent<{ knowledgeBaseId?: string }>
      ).detail?.knowledgeBaseId;
      if (knowledgeBaseId) setSelectedId(knowledgeBaseId);
    };
    const handleNewBase = (): void => setDialogOpen(true);
    window.addEventListener(BASE_SELECT_EVENT, handleBaseSelect);
    window.addEventListener(NEW_BASE_EVENT, handleNewBase);
    return () => {
      window.removeEventListener(BASE_SELECT_EVENT, handleBaseSelect);
      window.removeEventListener(NEW_BASE_EVENT, handleNewBase);
    };
  }, []);

  const choosePaths = async () => {
    const selectedPaths = await window.electronAPI.openFolderDialog();
    if (selectedPaths.length) {
      setPaths((current) => [...new Set([...current, ...selectedPaths])]);
    }
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
    ) {
      return;
    }
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
    <main className="app-shell-content-stage h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-hidden">
      <div className="kb-workbench">
        <header className="kb-workbench-header">
          <div className="min-w-0">
            <p className="kb-workbench-kicker">KNOWLEDGE</p>
            <h1 className="kb-workbench-title">知识库</h1>
            <p className="kb-workbench-subtitle">
              {items.length
                ? items.length + " 个知识库 · 跨项目复用的确认资料"
                : "把确认过的资料整理成可持续查阅的集合"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            disabled={loading || busy}
            aria-label="刷新知识库"
            title="刷新知识库"
          >
            <ArrowClockwise
              size={16}
              className={cn(loading && "animate-spin")}
            />
          </Button>
        </header>
        {error ? (
          <div className="px-1 pb-3">
            <ErrorBanner message={error} />
          </div>
        ) : null}
        <div className="kb-workbench-body">
          {loading ? (
            <p className="kb-quiet-meta">正在加载知识库…</p>
          ) : items.length === 0 ? (
            <section className="kb-empty">
              <Books size={28} className="kb-empty-icon" weight="duotone" />
              <h2>还没有知识库</h2>
              <p>请使用左侧知识库列表顶部的“新建”创建第一套知识库。</p>
            </section>
          ) : (
            <section className="w-full max-w-4xl">
              <div className="grid grid-cols-2 border-y border-border/50 md:grid-cols-4">
                <KnowledgeOverviewStat
                  label="知识库"
                  value={String(items.length)}
                />
                <KnowledgeOverviewStat
                  label="文档"
                  value={
                    documentCountLoading ? "…" : String(documentCount ?? "—")
                  }
                />
                <KnowledgeOverviewStat
                  label="来源目录"
                  value={String(totalSourceCount)}
                />
                <KnowledgeOverviewStat
                  label="最近更新"
                  value={
                    latestUpdatedAt
                      ? formatKnowledgeDate(latestUpdatedAt)
                      : "暂无"
                  }
                />
              </div>
            </section>
          )}
        </div>
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteTitle, setRemoteTitle] = useState("");
  const [browserImportOpened, setBrowserImportOpened] = useState(false);
  const setSidebarState = useSetAtom(knowledgeBaseSidebarAtom);
  const browserImportSessionId = "knowledge-base-import-" + item.id;

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.electronAPI.listKnowledgeBaseDocuments({
        knowledgeBaseId: item.id,
      });
      setDocuments(next);
      setActiveId(null);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [item.id, onError]);
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);
  useEffect(() => {
    setSidebarState({
      mode: "documents",
      knowledgeBaseId: item.id,
      knowledgeBaseName: item.name,
      documents,
      activeId,
      sources: item.sources,
      loading,
    });
  }, [
    activeId,
    documents,
    item.id,
    item.name,
    item.sources,
    loading,
    setSidebarState,
  ]);
  useEffect(() => {
    setActiveId(null);
    setMode("preview");
  }, [item.id]);
  const active = documents.find((doc) => doc.id === activeId) ?? null;
  const isDirty = Boolean(
    active &&
    (editorTitle !== active.title || editorContent !== active.content),
  );
  const confirmDiscard = () =>
    !isDirty || window.confirm("当前文档有未保存修改，确定放弃吗？");
  const selectDocument = (id: string) => {
    if (id === activeId || !confirmDiscard()) return;
    setActiveId(id);
    setMode("preview");
  };
  useEffect(() => {
    setEditorTitle(active?.title ?? "");
    setEditorContent(active?.content ?? "");
  }, [activeId, active?.content, active?.title]);

  const newDocument = async () => {
    if (!confirmDiscard()) return;
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
    if (!confirmDiscard()) return;
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
    if (!confirmDiscard()) return;
    setSaving(true);
    onError(null);
    try {
      const page = await browserApi().browserExtractWindowText(
        browserImportSessionId,
      );
      const content = page.text.trim();
      if (content.length < 40) {
        throw new Error(
          "当前网页正文太短，请先在内置浏览器中完成登录并打开文档正文",
        );
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

  useEffect(() => {
    const handleDocumentSelect = (event: Event): void => {
      const documentId = (event as CustomEvent<{ documentId?: string }>).detail
        ?.documentId;
      if (documentId) selectDocument(documentId);
    };
    const handleBaseBack = (): void => {
      if (confirmDiscard()) onBack();
    };
    const handleNewDocument = (): void => {
      void newDocument();
    };
    const handleRemoveSource = (event: Event): void => {
      const sourceId = (event as CustomEvent<{ sourceId?: string }>).detail
        ?.sourceId;
      if (sourceId) onRemoveSource(sourceId);
    };
    window.addEventListener(BASE_BACK_EVENT, handleBaseBack);
    window.addEventListener(DOCUMENT_SELECT_EVENT, handleDocumentSelect);
    window.addEventListener(NEW_DOCUMENT_EVENT, handleNewDocument);
    window.addEventListener(REMOVE_SOURCE_EVENT, handleRemoveSource);
    return () => {
      window.removeEventListener(BASE_BACK_EVENT, handleBaseBack);
      window.removeEventListener(DOCUMENT_SELECT_EVENT, handleDocumentSelect);
      window.removeEventListener(NEW_DOCUMENT_EVENT, handleNewDocument);
      window.removeEventListener(REMOVE_SOURCE_EVENT, handleRemoveSource);
    };
  }, [activeId, isDirty, item.id, onBack, onRemoveSource]);

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
    <main className="app-shell-content-stage h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-hidden">
      <div className="kb-workbench">
        <header className="kb-workbench-header">
          <div className="min-w-0">
            {active ? (
              <>
                <p className="kb-workbench-kicker">
                  {item.name}
                  <span className="mx-1.5 text-muted-foreground/40">/</span>
                  DOCUMENT
                </p>
                {mode === "edit" ? (
                  <input
                    value={editorTitle}
                    onChange={(e) => setEditorTitle(e.target.value)}
                    className="kb-workbench-title-input"
                    aria-label="文档标题"
                    placeholder="文档标题"
                  />
                ) : (
                  <h1 className="kb-workbench-title truncate">
                    {active.title}
                  </h1>
                )}
                <p className="kb-workbench-subtitle">
                  {isDirty ? "有未保存修改" : "已保存"}
                  {mode === "edit" ? " · Markdown 编辑" : ""}
                </p>
              </>
            ) : (
              <>
                <p className="kb-workbench-kicker">KNOWLEDGE BASE</p>
                <h1 className="kb-workbench-title truncate">{item.name}</h1>
                <p className="kb-workbench-subtitle">
                  {item.description || "知识库概览"}
                </p>
              </>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {active ? (
              mode === "edit" ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditorTitle(active.title);
                      setEditorContent(active.content);
                      setMode("preview");
                    }}
                    disabled={saving}
                  >
                    取消
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMode("preview")}
                    disabled={saving}
                  >
                    预览
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void save()}
                    disabled={saving || !editorTitle.trim() || !isDirty}
                  >
                    {saving ? "保存中…" : "保存"}
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setMode("edit")}>
                  编辑
                </Button>
              )
            ) : null}
            {!active ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant={active ? "outline" : "default"}
                    className="gap-1.5"
                    disabled={busy || saving}
                  >
                    添加内容
                    <CaretDown size={13} weight="bold" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 p-1.5">
                  <DropdownMenuItem onSelect={() => void newDocument()}>
                    <FileText size={15} className="mr-2" />
                    新建文档
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void importDocument()}>
                    <FileArrowUp size={15} className="mr-2" />
                    导入本地文件
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setUrlDialogOpen(true)}>
                    <LinkSimple size={15} className="mr-2" />
                    导入云文档
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onAddSource}>
                    <FolderOpen size={15} className="mr-2" />
                    添加目录来源
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {active ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void remove()}
                disabled={saving}
                aria-label="删除文档"
                title="删除文档"
              >
                <Trash size={16} />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={onDelete}
                disabled={busy || saving}
                aria-label="删除知识库"
                title="删除知识库"
              >
                <Trash size={16} />
              </Button>
            )}
          </div>
        </header>
        {error ? (
          <div className="px-1 pb-3">
            <ErrorBanner message={error} />
          </div>
        ) : null}
        <div className="kb-workbench-body">
          {active ? (
            <div className="kb-reader">
              {active.sourceUrl ? (
                <div className="kb-reader-source">
                  <a
                    href={active.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-xs text-primary hover:underline"
                    title={active.sourceUrl}
                  >
                    来源：{active.sourceUrl}
                  </a>
                  {(active.sourceProvider || active.sourceSyncedAt) && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {active.sourceProvider
                        ? sourceProviderLabel(active.sourceProvider)
                        : "云文档"}
                      {active.sourceSyncedAt
                        ? " · 快照于 " +
                          new Date(active.sourceSyncedAt).toLocaleString()
                        : ""}
                    </p>
                  )}
                </div>
              ) : null}
              {mode === "edit" ? (
                <textarea
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                  className="kb-editor"
                  aria-label="文档内容"
                  placeholder="在这里写下确认过的知识…"
                />
              ) : editorContent ? (
                <MessageResponse className="kb-reader-prose w-full max-w-none break-words">
                  {editorContent}
                </MessageResponse>
              ) : (
                <p className="kb-quiet-meta">空文档</p>
              )}
            </div>
          ) : loading ? (
            <p className="kb-quiet-meta">正在加载文档…</p>
          ) : documents.length ? (
            <section className="w-full max-w-4xl">
              <div className="grid grid-cols-2 border-y border-border/50 md:grid-cols-4">
                <KnowledgeOverviewStat
                  label="文档"
                  value={String(documents.length)}
                />
                <KnowledgeOverviewStat
                  label="来源目录"
                  value={String(item.sources.length)}
                />
                <KnowledgeOverviewStat label="内容状态" value="可查阅" />
                <KnowledgeOverviewStat
                  label="最近更新"
                  value={formatKnowledgeDate(item.updatedAt)}
                />
              </div>
            </section>
          ) : (
            <section className="kb-empty kb-empty--inline">
              <h2>还没有文档</h2>
              <p>
                用右上角「添加内容」新建
                Markdown，或导入本地文件、云文档、目录来源。
              </p>
            </section>
          )}
        </div>
      </div>
      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>导入云文档</DialogTitle>
          <DialogDescription>
            在独立的 TAgent
            浏览器窗口中打开文档。你可以在完整窗口中登录、扫码并打开正文。
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
