// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { CSSProperties, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ModelContext } from './contexts.ts';
import { Toast } from 'primereact/toast';
import { blurHashToImage, imageToBlurhash, imageToThumbhash, thumbHashToImage } from '../io/image_hashes.ts';
import { InputTextarea } from 'primereact/inputtextarea';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { ViewerComment, ViewerCommentCopilotEdit } from '../state/app-state.ts';
import FilePicker from './FilePicker.tsx';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": any;
    }
  }
}

export const PREDEFINED_ORBITS: [string, number, number][] = [
  ["Diagonal", Math.PI / 4, Math.PI / 4],
  ["Front", 0, Math.PI / 2],
  ["Right", Math.PI / 2, Math.PI / 2],
  ["Back", Math.PI, Math.PI / 2],
  ["Left", -Math.PI / 2, Math.PI / 2],
  ["Top", 0, 0],
  ["Bottom", 0, Math.PI],
];

function spherePoint(theta: number, phi: number): [number, number, number] {
  return [
    Math.cos(theta) * Math.sin(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(phi),
  ];
}

function euclideanDist(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
const radDist = (a: number, b: number) => Math.min(Math.abs(a - b), Math.abs(a - b + 2 * Math.PI), Math.abs(a - b - 2 * Math.PI));

function getClosestPredefinedOrbitIndex(theta: number, phi: number): [number, number, number] {
  const point = spherePoint(theta, phi);
  const points = PREDEFINED_ORBITS.map(([_, t, p]) => spherePoint(t, p));
  const distances = points.map(p => euclideanDist(point, p));
  const radDistances = PREDEFINED_ORBITS.map(([_, ptheta, pphi]) => Math.max(radDist(theta, ptheta), radDist(phi, pphi)));
  const [index, dist] = distances.reduce((acc, d, i) => d < acc[1] ? [i, d] : acc, [0, Infinity]) as [number, number];
  return [index, dist, radDistances[index]];
}

const originalOrbit = (([name, theta, phi]) => `${theta}rad ${phi}rad auto`)(PREDEFINED_ORBITS[0]);

type CommentCopilotEditRequest = {
  requestId: string,
  commentId: string,
  commentText: string,
  activePath: string,
  source: string,
  sources: {path: string, content?: string, url?: string}[],
  requestedAt: string,
};

type CommentCopilotEditResponse = {
  requestId: string,
  commentId: string,
  updatedSource?: string,
  summary?: string,
  error?: string,
};

type DebugLogEntry = {
  id: string,
  at: string,
  level: 'info' | 'error',
  message: string,
};

type AppliedEditHistoryEntry = {
  id: string,
  requestId: string,
  at: string,
  path: string,
  previousSource: string,
  nextSource: string,
  summary?: string,
};

type ValidationCheck = {
  id: string,
  label: string,
  status: 'pending' | 'pass' | 'fail',
  detail: string,
  updatedAt: string,
};

type ProtocolTraceEntry = {
  id: string,
  at: string,
  direction: 'env->copilot' | 'copilot->env' | 'system',
  label: string,
  payload: string,
  durationMs?: number,
  ok: boolean,
};

type LocalFallbackResult = {
  updatedSource: string,
  summary: string,
};

export default function ViewerPanel({className, style}: {className?: string, style?: CSSProperties}) {
  const model = useContext(ModelContext);
  if (!model) throw new Error('No model');

  const state = model.state;
  const comments = state.view.comments ?? [];
  const [newCommentText, setNewCommentText] = useState('');
  const [localFallbackEnabled, setLocalFallbackEnabled] = useState(true);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [appliedEditHistory, setAppliedEditHistory] = useState<AppliedEditHistoryEntry[]>([]);
  const [protocolTrace, setProtocolTrace] = useState<ProtocolTraceEntry[]>([]);
  const [validationChecks, setValidationChecks] = useState<ValidationCheck[]>([
    {id: 'env-capabilities', label: 'Environment capabilities', status: 'pending', detail: 'Waiting for checks', updatedAt: new Date().toISOString()},
    {id: 'request-dispatch', label: 'Copilot request dispatch', status: 'pending', detail: 'No request sent yet', updatedAt: new Date().toISOString()},
    {id: 'response-handling', label: 'Copilot response handling', status: 'pending', detail: 'No response received yet', updatedAt: new Date().toISOString()},
    {id: 'source-apply', label: 'Source apply + preview', status: 'pending', detail: 'No source update applied yet', updatedAt: new Date().toISOString()},
    {id: 'undo-flow', label: 'Undo flow', status: 'pending', detail: 'No undo executed yet', updatedAt: new Date().toISOString()},
    {id: 'runtime-stream', label: 'Runtime stream logs', status: 'pending', detail: 'No stream logs observed yet', updatedAt: new Date().toISOString()},
  ]);
  const [interactionPrompt, setInteractionPrompt] = useState('auto');
  const modelViewerRef = useRef<any>();
  const axesViewerRef = useRef<any>();
  const toastRef = useRef<Toast>(null);
  const commentSyncChannelRef = useRef<BroadcastChannel | null>(null);
  const commentSyncClientIdRef = useRef((window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`));
  const debugConsoleRef = useRef<HTMLDivElement | null>(null);
  const runLogsStreamStateRef = useRef<{logsRef?: State['currentRunLogs'], index: number}>({index: 0});
  const pendingRequestSentAtRef = useRef<Record<string, number>>({});
  const pendingRequestByCommentIdRef = useRef<Record<string, string>>({});

  const [loadedUri, setLoadedUri] = useState<string | undefined>();

  const [cachedImageHash, setCachedImageHash] = useState<{hash: string, uri: string} | undefined>(undefined);

  const modelUri = state.output?.displayFileURL ?? state.output?.outFileURL ?? '';
  const loaded = loadedUri === modelUri;
  const flowProgress = state.checkingSyntax ? 20
    : state.previewing ? 60
    : state.rendering ? 85
    : state.exporting ? 95
    : state.output ? 100
    : 0;
  const flowLabel = state.checkingSyntax ? 'Checking syntax'
    : state.previewing ? 'Preview rendering'
    : state.rendering ? 'Rendering'
    : state.exporting ? 'Exporting'
    : state.output ? 'Ready'
    : 'Idle';
  const goalsMet = ['env-capabilities', 'request-dispatch', 'response-handling', 'source-apply', 'runtime-stream']
    .every(id => validationChecks.find(c => c.id === id)?.status === 'pass');

  const safeStringify = useCallback((value: unknown) => {
    try {
      return JSON.stringify(value, null, 2);
    } catch (e) {
      return `[unserializable payload: ${String(e)}]`;
    }
  }, []);

  const appendProtocolTrace = useCallback((entry: Omit<ProtocolTraceEntry, 'id' | 'at'>) => {
    setProtocolTrace(previous => ([...previous, {
      id: window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      at: new Date().toISOString(),
      ...entry,
    }]).slice(-120));
  }, []);

  const applyLocalFallbackEdit = useCallback((source: string, commentText: string): LocalFallbackResult | undefined => {
    const normalized = commentText.toLowerCase();
    const asksTop = /\b(add|create|make)\b/.test(normalized) && /\btop\b/.test(normalized);
    const asksHole = /\bhole\b/.test(normalized) || /\bcenter\b/.test(normalized) || /\bcentre\b/.test(normalized);
    const asksMouthpiece = /\bergonomic\b/.test(normalized) || /\bmouthpiece\b/.test(normalized);
    const marker = '// AUTO_FALLBACK_TOP_WITH_CENTER_HOLE';
    if ((!asksTop || !asksHole) && !asksMouthpiece) {
      return undefined;
    }

    const centerHoleBlock = `${marker}
module auto_fallback_top_with_center_hole() {
    top_outer_d = (base_d * top_scale);
    top_hole_d = vent_d * 0.8;
    translate([0, 0, height])
        difference() {
            cylinder(h = wall, d = top_outer_d);
            translate([0, 0, -0.1])
                cylinder(h = wall + 0.2, d = top_hole_d);
        }
}

auto_fallback_top_with_center_hole();`;

    const mouthpieceBlock = `${marker}
// AUTO_FALLBACK_MOUTHPIECE
module auto_fallback_top_with_center_hole() {
    top_outer_d = (base_d * top_scale);
    mouthpiece_major_d = vent_d * 0.62;
    mouthpiece_minor_d = vent_d * 0.46;
    mouthpiece_offset = vent_d * 0.17;

    module ergonomic_mouthpiece_cutout() {
        linear_extrude(height = wall + 0.2)
            hull() {
                translate([0, mouthpiece_offset, 0])
                    circle(d = mouthpiece_major_d);
                translate([0, -mouthpiece_offset, 0])
                    circle(d = mouthpiece_minor_d);
            }
    }

    translate([0, 0, height])
        difference() {
            cylinder(h = wall, d = top_outer_d);
            translate([0, 0, -0.1])
                ergonomic_mouthpiece_cutout();
        }
}

auto_fallback_top_with_center_hole();`;

    const fallbackBlockRegex = /\/\/ AUTO_FALLBACK_TOP_WITH_CENTER_HOLE[\s\S]*?auto_fallback_top_with_center_hole\(\);/m;

    if (asksMouthpiece) {
      if (fallbackBlockRegex.test(source)) {
        return {
          updatedSource: source.replace(fallbackBlockRegex, mouthpieceBlock),
          summary: 'Adjusted top opening to ergonomic mouthpiece',
        };
      }
      return {
        updatedSource: `${source.trimEnd()}\n\n${mouthpieceBlock}\n`,
        summary: 'Added top with ergonomic mouthpiece opening',
      };
    }

    if (source.includes(marker)) {
      return {
        updatedSource: source,
        summary: 'Top with center hole already present',
      };
    }

    return {
      updatedSource: `${source.trimEnd()}\n\n${centerHoleBlock}\n`,
      summary: 'Added top with center hole',
    };
  }, []);

  const setValidationCheck = useCallback((id: ValidationCheck['id'], update: {status: ValidationCheck['status'], detail: string}) => {
    setValidationChecks(previous => previous.map(check => check.id !== id ? check : {
      ...check,
      status: update.status,
      detail: update.detail,
      updatedAt: new Date().toISOString(),
    }));
  }, []);

  const runValidationSweep = useCallback(() => {
    const checks = [
      typeof window !== 'undefined',
      typeof window.CustomEvent === 'function',
      !!window.crypto,
      typeof window.crypto?.randomUUID === 'function',
      typeof window.dispatchEvent === 'function',
      typeof window.addEventListener === 'function',
    ];
    const passCount = checks.filter(Boolean).length;
    const ok = passCount === checks.length;
    setValidationCheck('env-capabilities', {
      status: ok ? 'pass' : 'fail',
      detail: `${passCount}/${checks.length} capability checks passed`,
    });

    const hasFlowState = !!model.state.params.activePath && Array.isArray(model.state.params.sources);
    if (!hasFlowState) {
      setValidationCheck('source-apply', {
        status: 'fail',
        detail: 'Model state missing active path or sources',
      });
    }
  }, [model.state.params.activePath, model.state.params.sources, setValidationCheck]);

  const appendDebugLog = useCallback((level: DebugLogEntry['level'], message: string) => {
    const at = new Date().toISOString();
    setDebugLogs(previous => {
      const next = [...previous, {
        id: window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        at,
        level,
        message,
      }];
      return next.slice(-200);
    });
  }, []);

  const clearDebugLogs = useCallback(() => {
    setDebugLogs([]);
    setProtocolTrace([]);
  }, []);

  const undoLastAppliedEdit = useCallback(() => {
    const latest = appliedEditHistory[appliedEditHistory.length - 1];
    if (!latest) {
      appendDebugLog('info', 'Undo requested but history is empty');
      setValidationCheck('undo-flow', {
        status: 'fail',
        detail: 'Undo requested with empty history',
      });
      return;
    }
    if (model.state.params.activePath !== latest.path) {
      model.openFile(latest.path);
    }
    model.source = latest.previousSource;
    model.render({isPreview: true, now: true});
    setAppliedEditHistory(previous => previous.slice(0, -1));
    appendDebugLog('info', `Undo applied for request ${latest.requestId.slice(0, 8)} on ${latest.path}`);
    setValidationCheck('undo-flow', {
      status: 'pass',
      detail: `Undo applied for ${latest.requestId.slice(0, 8)}`,
    });
  }, [appliedEditHistory, appendDebugLog, model, setValidationCheck]);

  const setComments = useCallback((nextCommentsOrUpdater: ViewerComment[] | ((previous: ViewerComment[]) => ViewerComment[]), sync = true) => {
    const previousComments = model.state.view.comments ?? [];
    const nextComments = typeof nextCommentsOrUpdater === 'function'
      ? nextCommentsOrUpdater(previousComments)
      : nextCommentsOrUpdater;
    model.mutate(s => {
      s.view.comments = nextComments;
    });
    if (sync) {
      commentSyncChannelRef.current?.postMessage({
        clientId: commentSyncClientIdRef.current,
        comments: nextComments,
      });
    }
  }, [model]);

  const pushCommentCopilotHistoryEntry = useCallback((commentId: string, entry: ViewerCommentCopilotEdit) => {
    setComments(previous => previous.map(comment => comment.id !== commentId ? comment : {
      ...comment,
      copilotEditHistory: [...(comment.copilotEditHistory ?? []), entry],
    }));
  }, [setComments]);

  const resolveCommentCopilotHistoryEntry = useCallback((requestId: string, resolver: (entry: ViewerCommentCopilotEdit) => ViewerCommentCopilotEdit) => {
    setComments(previous => previous.map(comment => {
      const history = comment.copilotEditHistory ?? [];
      const index = history.findIndex(entry => entry.requestId === requestId);
      if (index < 0) {
        return comment;
      }
      const nextHistory = [...history];
      nextHistory[index] = resolver(nextHistory[index]);
      return {
        ...comment,
        copilotEditHistory: nextHistory,
      };
    }));
  }, [setComments]);

  const requestCopilotEditFromComment = useCallback((comment: ViewerComment) => {
    const existingPendingRequestId = pendingRequestByCommentIdRef.current[comment.id];
    if (existingPendingRequestId) {
      appendDebugLog('info', `Skipped duplicate request for comment ${comment.id.slice(0, 8)} (pending ${existingPendingRequestId.slice(0, 8)})`);
      appendProtocolTrace({
        direction: 'system',
        label: `duplicate request blocked ${existingPendingRequestId.slice(0, 8)}`,
        payload: `Comment ${comment.id} already has an in-flight request`,
        ok: false,
      });
      return;
    }

    const requestId = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingRequestByCommentIdRef.current[comment.id] = requestId;
    const requestedAt = new Date().toISOString();
    appendDebugLog('info', `Request ${requestId.slice(0, 8)} sent for ${model.state.params.activePath}`);
    setValidationCheck('request-dispatch', {
      status: 'pass',
      detail: `Request ${requestId.slice(0, 8)} dispatched`,
    });
    pushCommentCopilotHistoryEntry(comment.id, {
      requestId,
      requestedAt,
      status: 'pending',
      path: model.state.params.activePath,
      summary: 'Sent to Copilot',
    });

    const request: CommentCopilotEditRequest = {
      requestId,
      commentId: comment.id,
      commentText: comment.text,
      activePath: model.state.params.activePath,
      source: model.source,
      sources: model.state.params.sources,
      requestedAt,
    };

    try {
      pendingRequestSentAtRef.current[requestId] = performance.now();
      window.dispatchEvent(new CustomEvent<CommentCopilotEditRequest>('openscad-playground-comment-edit-request', {
        detail: request,
      }));
      appendProtocolTrace({
        direction: 'env->copilot',
        label: `comment-edit-request ${requestId.slice(0, 8)}`,
        payload: safeStringify({
          ...request,
          sourceLength: request.source.length,
          sources: request.sources.map(s => ({path: s.path, hasContent: s.content != null, url: s.url})),
        }),
        ok: true,
      });
    } catch (e) {
      delete pendingRequestByCommentIdRef.current[comment.id];
      appendProtocolTrace({
        direction: 'system',
        label: `request dispatch failed ${requestId.slice(0, 8)}`,
        payload: String(e),
        ok: false,
      });
      appendDebugLog('error', `Failed to dispatch request ${requestId.slice(0, 8)}: ${String(e)}`);
      setValidationCheck('request-dispatch', {
        status: 'fail',
        detail: `Dispatch failed for ${requestId.slice(0, 8)}`,
      });
      return;
    }

    window.setTimeout(() => {
      const latestComment = (model.state.view.comments ?? []).find(c => c.id === comment.id);
      const pendingEntry = latestComment?.copilotEditHistory?.find(entry => entry.requestId === requestId);
      const stillPending = pendingEntry?.status === 'pending';

      if (!stillPending) {
        return;
      }

      delete pendingRequestByCommentIdRef.current[comment.id];
      resolveCommentCopilotHistoryEntry(requestId, entry => {
        if (entry.status !== 'pending') {
          return entry;
        }
        return {
          ...entry,
          status: 'failed',
          resolvedAt: new Date().toISOString(),
          error: 'Timed out waiting for Copilot response',
          summary: 'No Copilot host response',
        };
      });
      appendDebugLog('error', `Request ${requestId.slice(0, 8)} timed out waiting for Copilot response`);
      appendProtocolTrace({
        direction: 'system',
        label: `request timeout ${requestId.slice(0, 8)}`,
        payload: 'No response event received within 30 seconds',
        ok: false,
      });
      setValidationCheck('response-handling', {
        status: 'fail',
        detail: `Request ${requestId.slice(0, 8)} timed out`,
      });
    }, 30000);

    window.setTimeout(() => {
      if (!localFallbackEnabled) {
        return;
      }
      const activePending = pendingRequestByCommentIdRef.current[comment.id] === requestId;
      if (!activePending) {
        return;
      }

      const nextSource = applyLocalFallbackEdit(model.source, comment.text);
      if (!nextSource) {
        appendProtocolTrace({
          direction: 'system',
          label: `local fallback skipped ${requestId.slice(0, 8)}`,
          payload: 'No deterministic local transformation available for this comment',
          ok: false,
        });
        window.dispatchEvent(new CustomEvent<CommentCopilotEditResponse>('openscad-playground-comment-edit-response', {
          detail: {
            requestId,
            commentId: comment.id,
            error: 'Local fallback has no deterministic transform for this request',
            summary: 'Fallback unsupported for this comment',
          },
        }));
        return;
      }

      appendProtocolTrace({
        direction: 'system',
        label: `local fallback response ${requestId.slice(0, 8)}`,
        payload: 'Generated local response because external bridge did not reply in time',
        ok: true,
      });
      window.dispatchEvent(new CustomEvent<CommentCopilotEditResponse>('openscad-playground-comment-edit-response', {
        detail: {
          requestId,
          commentId: comment.id,
          updatedSource: nextSource.updatedSource,
          summary: nextSource.summary,
        },
      }));
    }, 1500);
  }, [appendDebugLog, appendProtocolTrace, model, pushCommentCopilotHistoryEntry, resolveCommentCopilotHistoryEntry, safeStringify, setValidationCheck]);

  const addComment = useCallback(() => {
    const text = newCommentText.trim();
    if (!text) return;
    const now = new Date().toISOString();
    const comment: ViewerComment = {
      id: window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      createdAt: now,
      updatedAt: now,
    };
    setComments([...comments, comment]);
    appendDebugLog('info', `Comment created (${text.slice(0, 60)})`);
    requestCopilotEditFromComment(comment);
    setNewCommentText('');
  }, [appendDebugLog, comments, newCommentText, requestCopilotEditFromComment, setComments]);

  const updateComment = useCallback((id: string, text: string) => {
    const now = new Date().toISOString();
    setComments(comments.map(comment => comment.id === id ? {...comment, text, updatedAt: now} : comment));
  }, [comments, setComments]);

  const removeComment = useCallback((id: string) => {
    setComments(comments.filter(comment => comment.id !== id));
    appendDebugLog('info', `Comment removed (${id.slice(0, 8)})`);
  }, [appendDebugLog, comments, setComments]);

  if (state?.preview) {
    let {hash, uri} = cachedImageHash ?? {};
    if (state.preview.blurhash && hash !== state.preview.blurhash) {
      hash = state.preview.blurhash;
      uri = blurHashToImage(hash, 100, 100);
      setCachedImageHash({hash, uri});
    } else if (state.preview.thumbhash && hash !== state.preview.thumbhash) {
      hash = state.preview.thumbhash;
      uri = thumbHashToImage(hash);
      setCachedImageHash({hash, uri});
    }
  } else if (cachedImageHash) {
    setCachedImageHash(undefined);
  }

  const onLoad = useCallback(async (e: any) => {
    setLoadedUri(modelUri);
    console.log('onLoad', e);

    if (!modelViewerRef.current) return;

    const uri = await modelViewerRef.current.toDataURL('image/png', 0.5);
    const preview = {blurhash: await imageToBlurhash(uri)};
    // const preview = {thumbhash: await imageToThumbhash(uri)};
    console.log(preview);
    
    model?.mutate(s => s.preview = preview);
  }, [model, modelUri, setLoadedUri, modelViewerRef.current]);

  useEffect(() => {
    if (!modelViewerRef.current) return;

    const element = modelViewerRef.current;
    element.addEventListener('load', onLoad);
    return () => element.removeEventListener('load', onLoad);
  }, [modelViewerRef.current, onLoad]);

  useEffect(() => {
    if (!(window as any).BroadcastChannel) return;
    const channel = new BroadcastChannel('openscad-playground-comments');
    commentSyncChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as {clientId?: string, comments?: ViewerComment[]};
      if (!data || data.clientId === commentSyncClientIdRef.current || !Array.isArray(data.comments)) {
        return;
      }
      setComments(data.comments, false);
    };
    return () => {
      channel.close();
      commentSyncChannelRef.current = null;
    };
  }, [setComments]);

  useEffect(() => {
    const onCopilotEditResponse = (event: Event) => {
      const customEvent = event as CustomEvent<CommentCopilotEditResponse>;
      const detail = customEvent.detail;
      if (!detail?.requestId) {
        appendProtocolTrace({
          direction: 'copilot->env',
          label: 'response missing requestId',
          payload: safeStringify(detail),
          ok: false,
        });
        appendDebugLog('error', 'Received malformed response without requestId');
        setValidationCheck('response-handling', {
          status: 'fail',
          detail: 'Malformed response without requestId',
        });
        return;
      }

      const startedAt = pendingRequestSentAtRef.current[detail.requestId];
      const durationMs = startedAt != null ? Math.round(performance.now() - startedAt) : undefined;
      delete pendingRequestSentAtRef.current[detail.requestId];

      const sourceCommentId = detail.commentId;
      if (sourceCommentId && pendingRequestByCommentIdRef.current[sourceCommentId] === detail.requestId) {
        delete pendingRequestByCommentIdRef.current[sourceCommentId];
      }

      appendProtocolTrace({
        direction: 'copilot->env',
        label: `comment-edit-response ${detail.requestId.slice(0, 8)}`,
        payload: safeStringify({
          ...detail,
          updatedSourceLength: detail.updatedSource?.length,
        }),
        durationMs,
        ok: !detail.error,
      });

      const now = new Date().toISOString();
      setValidationCheck('response-handling', {
        status: detail.error ? 'fail' : 'pass',
        detail: detail.error ? `Response failed: ${detail.error}` : `Response ${detail.requestId.slice(0, 8)} handled`,
      });
      if (typeof detail.updatedSource === 'string') {
        const previousSource = model.source;
        model.source = detail.updatedSource;
        model.render({isPreview: true, now: true});
        if (detail.updatedSource !== previousSource) {
          setAppliedEditHistory(previous => ([...previous, {
            id: window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            requestId: detail.requestId,
            at: now,
            path: model.state.params.activePath,
            previousSource,
            nextSource: detail.updatedSource,
            summary: detail.summary,
          }]).slice(-100));
        }
        appendDebugLog('info', `Response ${detail.requestId.slice(0, 8)} applied source update + live preview`);
        setValidationCheck('source-apply', {
          status: 'pass',
          detail: `Source update applied for ${detail.requestId.slice(0, 8)}`,
        });
      } else {
        appendDebugLog('info', `Response ${detail.requestId.slice(0, 8)} received without source update`);
        setValidationCheck('source-apply', {
          status: 'fail',
          detail: `Response ${detail.requestId.slice(0, 8)} had no source payload`,
        });
      }

      resolveCommentCopilotHistoryEntry(detail.requestId, entry => ({
        ...entry,
        status: detail.error ? 'failed' : 'applied',
        resolvedAt: now,
        summary: detail.summary ?? (detail.error ? 'Copilot edit failed' : 'Applied Copilot edit'),
        error: detail.error,
      }));

      if (detail.error) {
        appendDebugLog('error', `Response ${detail.requestId.slice(0, 8)} failed: ${detail.error}`);
      }
    };

    window.addEventListener('openscad-playground-comment-edit-response', onCopilotEditResponse as EventListener);
    return () => window.removeEventListener('openscad-playground-comment-edit-response', onCopilotEditResponse as EventListener);
  }, [appendDebugLog, appendProtocolTrace, model, resolveCommentCopilotHistoryEntry, safeStringify, setValidationCheck]);

  useEffect(() => {
    const onWindowError = (event: ErrorEvent) => {
      appendDebugLog('error', `Window error: ${event.message}`);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      appendDebugLog('error', `Unhandled rejection: ${String(event.reason)}`);
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [appendDebugLog]);

  useEffect(() => {
    const logs = state.currentRunLogs;
    const streamState = runLogsStreamStateRef.current;
    if (!logs) {
      streamState.logsRef = logs;
      streamState.index = 0;
      return;
    }
    if (streamState.logsRef !== logs) {
      streamState.logsRef = logs;
      streamState.index = 0;
      appendDebugLog('info', 'Render log stream started');
      setValidationCheck('runtime-stream', {
        status: 'pass',
        detail: 'Render stream detected',
      });
    }
    for (let i = streamState.index; i < logs.length; i++) {
      const [type, text] = logs[i];
      const compact = text.replace(/\s+/g, ' ').trim().slice(0, 220);
      appendDebugLog(type === 'stderr' ? 'error' : 'info', `[${type}] ${compact}`);
    }
    streamState.index = logs.length;
  }, [appendDebugLog, state.currentRunLogs]);

  useEffect(() => {
    runValidationSweep();
  }, [runValidationSweep]);

  useEffect(() => {
    if (!debugConsoleRef.current) return;
    debugConsoleRef.current.scrollTop = debugConsoleRef.current.scrollHeight;
  }, [debugLogs]);


  for (const ref of [modelViewerRef, axesViewerRef]) {
    const otherRef = ref === modelViewerRef ? axesViewerRef : modelViewerRef;
    useEffect(() => {
      if (!ref.current) return;

      function handleCameraChange(e: any) {
        if (!otherRef.current) return;
        if (e.detail.source === 'user-interaction') {
          const cameraOrbit = ref.current.getCameraOrbit();
          cameraOrbit.radius = otherRef.current.getCameraOrbit().radius;
        
          otherRef.current.cameraOrbit = cameraOrbit.toString();
        }
      }
      const element = ref.current;
      element.addEventListener('camera-change', handleCameraChange);
      return () => element.removeEventListener('camera-change', handleCameraChange);
    }, [ref.current, otherRef.current]);
  }

  // Cycle through predefined views when user clicks on the axes viewer
  useEffect(() => {
    let mouseDownSpherePoint: [number, number, number] | undefined;
    function getSpherePoint() {
      const orbit = axesViewerRef.current.getCameraOrbit();
      return spherePoint(orbit.theta, orbit.phi);
    }
    function onMouseDown(e: MouseEvent) {
      if (e.target === axesViewerRef.current) {
        mouseDownSpherePoint = getSpherePoint();
      }
    }
    function onMouseUp(e: MouseEvent) {
      if (e.target === axesViewerRef.current) {
        const euclEps = 0.01;
        const radEps = 0.1;

        const spherePoint = getSpherePoint();
        const clickDist = mouseDownSpherePoint ? euclideanDist(spherePoint, mouseDownSpherePoint) : Infinity;
        if (clickDist > euclEps) {
          return;
        }
        // Note: unlike the axes viewer, the model viewer has a prompt that makes the model wiggle around, we only fetch it to get the radius.
        const axesOrbit = axesViewerRef.current.getCameraOrbit();
        const modelOrbit = modelViewerRef.current.getCameraOrbit();
        const [currentIndex, dist, radDist] = getClosestPredefinedOrbitIndex(axesOrbit.theta, axesOrbit.phi);
        const newIndex = dist < euclEps && radDist < radEps ? (currentIndex + 1) % PREDEFINED_ORBITS.length : currentIndex;
        const [name, theta, phi] = PREDEFINED_ORBITS[newIndex];
        Object.assign(modelOrbit, {theta, phi});
        const newOrbit = modelViewerRef.current.cameraOrbit = axesViewerRef.current.cameraOrbit = modelOrbit.toString();
        toastRef.current?.show({severity: 'info', detail: `${name} view`, life: 1000,});
        setInteractionPrompt('none');
      }
    }
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    // window.addEventListener('click', onClick);
    return () => {
      // window.removeEventListener('click', onClick);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  });

  return (
    <div className={className}
          style={{
              display: 'flex',
              flexDirection: 'column', 
              position: 'relative',
              flex: 1, 
              width: '100%',
              ...(style ?? {})
          }}>
      <Toast ref={toastRef} position='top-right'  />
      <style>
        {`
          @keyframes pulse {
            0% { opacity: 0.4; }
            50% { opacity: 0.7; }
            100% { opacity: 0.4; }
          }
        `}
      </style>

      {!loaded && cachedImageHash && 
        <img
        src={cachedImageHash.uri}
        style={{
          animation: 'pulse 1.5s ease-in-out infinite',
          position: 'absolute',
          pointerEvents: 'none',
          width: '100%',
          height: '100%'
        }} />
      }

      <model-viewer
        orientation="0deg -90deg 0deg"
        class="main-viewer"
        src={modelUri}
        style={{
          transition: 'opacity 0.5s',
          opacity: loaded ? 1 : 0,
          position: 'absolute',
          width: '100%',
          height: '100%',
        }}
        camera-orbit={originalOrbit}
        interaction-prompt={interactionPrompt}
        environment-image="./skybox-lights.jpg"
        max-camera-orbit="auto 180deg auto"
        min-camera-orbit="auto 0deg auto"
        camera-controls
        ar
        ref={modelViewerRef}
      >
        <span slot="progress-bar"></span>
      </model-viewer>
      {state.view.showAxes && (
        <model-viewer
                orientation="0deg -90deg 0deg"
                src="./axes.glb"
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  zIndex: 10,
                  height: '100px',
                  width: '100px',
                }}
                loading="eager"
                camera-orbit={originalOrbit}
                // interpolation-decay="0"
                environment-image="./skybox-lights.jpg"
                max-camera-orbit="auto 180deg auto"
                min-camera-orbit="auto 0deg auto"
                orbit-sensitivity="5"
                interaction-prompt="none"
                camera-controls="false"
                disable-zoom
                disable-tap 
                disable-pan
                ref={axesViewerRef}
        >
          <span slot="progress-bar"></span>
        </model-viewer>
      )}

      <div style={{
        position: 'absolute',
        top: '8px',
        right: '8px',
        zIndex: 11,
        width: '320px',
        maxHeight: '70%',
        overflowY: 'auto',
        padding: '8px',
        border: '1px solid var(--viewer-debug-border)',
        borderRadius: '6px',
        background: 'var(--viewer-debug-bg)',
        color: 'var(--viewer-debug-text)',
      }}>
        <div className="flex align-items-center justify-content-between mb-2">
          <strong>Comments</strong>
          <span>{comments.length}</span>
        </div>

        <div className="mb-2">
          <FilePicker style={{width: '100%'}} />
        </div>

        <div className="flex align-items-center justify-content-between mb-2" style={{fontSize: '0.75rem'}}>
          <span>Local fallback apply</span>
          <Button
            icon={localFallbackEnabled ? 'pi pi-check-circle' : 'pi pi-times-circle'}
            text
            severity={localFallbackEnabled ? 'success' : 'secondary'}
            onClick={() => setLocalFallbackEnabled(value => !value)}
            title="Toggle local fallback updates when external bridge does not respond"
          />
        </div>

        <div className="flex gap-2 mb-2">
          <InputTextarea
            value={newCommentText}
            onChange={e => setNewCommentText(e.target.value)}
            rows={2}
            autoResize
            placeholder="Add a comment"
            style={{flex: 1}}
          />
          <Button
            icon="pi pi-plus"
            onClick={addComment}
            disabled={!newCommentText.trim()}
            text
          />
        </div>

        <div className="flex flex-column gap-2">
          {comments.map(comment => (
            <div key={comment.id} style={{
              border: '1px solid var(--surface-border)',
              borderRadius: '6px',
              padding: '6px',
            }}>
              <div className="flex justify-content-between align-items-center mb-1">
                {(() => {
                  const latest = comment.copilotEditHistory?.[comment.copilotEditHistory.length - 1];
                  if (!latest) {
                    return <span style={{fontSize: '0.75rem', opacity: 0.7}}>Not sent</span>;
                  }
                  const statusText = latest.status === 'pending' ? 'Copilot pending'
                    : latest.status === 'applied' ? 'Copilot applied'
                    : 'Copilot failed';
                  return <span style={{fontSize: '0.75rem', opacity: 0.7}}>{statusText}</span>;
                })()}
                <div className="flex gap-1">
                  <Button
                    icon="pi pi-sparkles"
                    onClick={() => requestCopilotEditFromComment(comment)}
                    text
                    title="Apply with Copilot"
                  />
                <Button
                  icon="pi pi-trash"
                  onClick={() => removeComment(comment.id)}
                  text
                  severity="danger"
                />
                </div>
              </div>
              <InputTextarea
                value={comment.text}
                onChange={e => updateComment(comment.id, e.target.value)}
                rows={2}
                autoResize
                style={{width: '100%'}}
              />
            </div>
          ))}
        </div>

        <div className="flex align-items-center justify-content-between mt-3 mb-2">
          <strong>Debug Console</strong>
          <div className="flex gap-1">
            <Button icon="pi pi-check-circle" text severity="secondary" onClick={runValidationSweep} title="Run validation sweep" />
            <Button icon="pi pi-trash" text severity="secondary" onClick={clearDebugLogs} title="Clear debug logs" />
          </div>
        </div>

        <div className="mb-2" style={{fontSize: '0.75rem', opacity: 0.85}}>
          {flowLabel} ({flowProgress}%)
        </div>
        <ProgressBar value={flowProgress} style={{height: '6px', marginBottom: '8px'}} />

        <div className="mb-2" style={{fontSize: '0.75rem', fontWeight: 600}}>
          Goals: {goalsMet ? '✅ Fully met' : '⏳ In progress'}
        </div>

        <div className="mt-2 mb-2">
          <strong>Auto Validation</strong>
        </div>
        <div style={{
          border: '1px solid var(--viewer-debug-border)',
          borderRadius: '6px',
          padding: '6px',
          maxHeight: '150px',
          overflowY: 'auto',
          background: 'var(--viewer-debug-surface)',
          fontSize: '0.75rem',
          marginBottom: '8px',
        }}>
          {validationChecks.map(check => (
            <div key={check.id} style={{marginBottom: '4px'}}>
              {check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⏳'} {check.label}: {check.detail}
            </div>
          ))}
        </div>

        <div className="flex align-items-center justify-content-between mt-2 mb-2">
          <strong>Auto-update History</strong>
          <Button icon="pi pi-undo" text severity="secondary" onClick={undoLastAppliedEdit} disabled={appliedEditHistory.length === 0} title="Undo last applied update" />
        </div>

        <div style={{
          border: '1px solid var(--viewer-debug-border)',
          borderRadius: '6px',
          padding: '6px',
          maxHeight: '120px',
          overflowY: 'auto',
          background: 'var(--viewer-debug-surface)',
          fontSize: '0.75rem',
          marginBottom: '8px',
        }}>
          {appliedEditHistory.length === 0 && <div style={{opacity: 0.7}}>No applied updates yet.</div>}
          {[...appliedEditHistory].reverse().slice(0, 8).map(entry => (
            <div key={entry.id} style={{marginBottom: '4px'}}>
              [{entry.at.slice(11, 19)}] {entry.requestId.slice(0, 8)} {entry.path}
            </div>
          ))}
        </div>

        <div className="mt-2 mb-2">
          <strong>Protocol Trace</strong>
        </div>
        <div style={{
          border: '1px solid var(--viewer-debug-border)',
          borderRadius: '6px',
          padding: '6px',
          maxHeight: '170px',
          overflowY: 'auto',
          background: 'var(--viewer-debug-surface)',
          fontFamily: 'monospace',
          fontSize: '0.72rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          marginBottom: '8px',
        }}>
          {protocolTrace.length === 0 && <div style={{opacity: 0.7}}>No protocol messages yet.</div>}
          {protocolTrace.map(entry => (
            <div key={entry.id} style={{
              marginBottom: '6px',
              color: entry.ok ? undefined : 'var(--red-400)',
            }}>
              [{entry.at.slice(11, 19)}] {entry.direction} {entry.label}{entry.durationMs != null ? ` (${entry.durationMs}ms)` : ''}
              {'\n'}{entry.payload}
            </div>
          ))}
        </div>

        <div ref={debugConsoleRef} style={{
          border: '1px solid var(--viewer-debug-border)',
          borderRadius: '6px',
          padding: '6px',
          maxHeight: '170px',
          overflowY: 'auto',
          background: 'var(--viewer-debug-surface)',
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {debugLogs.length === 0 && <div style={{opacity: 0.7}}>No debug events yet.</div>}
          {debugLogs.map(log => (
            <div key={log.id} style={{
              marginBottom: '4px',
              color: log.level === 'error' ? 'var(--red-400)' : undefined,
            }}>
              [{log.at.slice(11, 19)}] {log.level.toUpperCase()} {log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
