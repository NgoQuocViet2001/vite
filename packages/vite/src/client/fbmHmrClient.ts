import type { FbmUpdatePayload, Update, UpdatePayload } from '#types/hmrPayload'
import { HMRClient, HMRContext, type HMRLogger } from '../shared/hmr'
import type { NormalizedModuleRunnerTransport } from '../shared/moduleRunnerTransport'

/**
 * The store + executor half of `__rolldown_runtime__`. The client reads topology and
 * execution truth through this narrow surface and owns every HMR judgment itself; no
 * acceptance data ever crosses it in the other direction.
 */
export interface RolldownRuntimeLike {
  getImporters(id: string): string[]
  isExecuted(id: string): boolean
  hasFactory(id: string): boolean
  removeModuleCache(id: string): void
  initModule(id: string): unknown
  loadExports(id: string): unknown
}

type HmrUpdate =
  | { type: 'noop' }
  | { type: 'full-reload'; reason: string }
  | {
    type: 'boundaries'
    /** `[boundary, acceptedVia]` pairs — same shape the server used to compute */
    boundaries: [string, string][]
    updateSet: string[]
  }

export interface FbmHMRClientOptions {
  base: string
  /**
   * Runs after the walk finds boundaries and `vite:beforeUpdate` fired, before anything
   * is fetched or evicted. Returning `'reload'` aborts the apply (the hook reloads the
   * page itself) — the first-update-with-error-overlay dance lives in the caller.
   */
  beforeApply: () => 'reload' | 'continue'
  pageReload: () => void
}

/**
 * The dedicated full-bundle-mode HMR client: webpack's acceptance model, hosted on
 * Vite's client, sized by rolldown's static walk. Acceptance is recorded when
 * `accept()` executes (the inherited `hotModulesMap` — written by `HMRContext`), the
 * boundary walk runs here against the runtime's rows and registry, and updates apply
 * one at a time in push order.
 */
export class FbmHMRClient extends HMRClient {
  private applyQueue = Promise.resolve()
  private lastSeq = 0

  constructor(
    logger: HMRLogger,
    transport: NormalizedModuleRunnerTransport,
    private runtime: RolldownRuntimeLike,
    private options: FbmHMRClientOptions,
  ) {
    super(logger, transport, async () => {
      throw new Error(
        'unreachable: full-bundle mode applies patches through its own queue',
      )
    })
  }

  // the two questions that used to be server-computed — now live map reads
  isSelfAccepted(id: string): boolean {
    return (
      this.hotModulesMap.get(id)?.callbacks.some((c) => c.deps.includes(id)) ??
      false
    )
  }

  acceptsDep(parent: string, id: string): boolean {
    return (
      this.hotModulesMap
        .get(parent)
        ?.callbacks.some((c) => c.deps.includes(id)) ?? false
    )
  }

  computeHmrUpdate(
    changedIds: string[],
    opts?: { firstInvalidatedBy?: string },
  ): HmrUpdate {
    const boundaries: [string, string][] = []
    const updateSet = new Set<string>()
    const traversedModules = new Set<string>()
    for (const changed of changedIds) {
      if (!this.runtime.isExecuted(changed)) {
        // this tab never ran it → nothing to update here
        continue
      }
      const fullReload = this.bubble(
        changed,
        [changed],
        updateSet,
        boundaries,
        opts?.firstInvalidatedBy,
        traversedModules,
      )
      if (fullReload) return fullReload
    }
    return boundaries.length
      ? { type: 'boundaries', boundaries, updateSet: [...updateSet] }
      : { type: 'noop' }
  }

  private bubble(
    id: string,
    stack: string[],
    updateSet: Set<string>,
    boundaries: [string, string][],
    firstInvalidatedBy: string | undefined,
    traversedModules: Set<string>,
  ): HmrUpdate | undefined {
    if (traversedModules.has(id)) return
    traversedModules.add(id)
    updateSet.add(id)
    if (firstInvalidatedBy !== undefined && id === firstInvalidatedBy) {
      return {
        type: 'full-reload',
        reason: `update propagated back to ${firstInvalidatedBy}, which already called \`import.meta.hot.invalidate()\``,
      }
    }
    if (this.isSelfAccepted(id)) {
      boundaries.push([id, id])
      return
    }
    const parents = this.runtime
      .getImporters(id)
      .filter((p) => this.runtime.isExecuted(p))
    if (!parents.length) {
      return {
        type: 'full-reload',
        reason: `no hmr boundary found for module \`${id}\``,
      }
    }
    for (const parent of parents) {
      if (this.acceptsDep(parent, id)) {
        boundaries.push([parent, id])
        continue
      }
      if (stack.includes(parent)) {
        return {
          type: 'full-reload',
          reason: `circular import chain between \`${id}\` and \`${parent}\``,
        }
      }
      const fullReload = this.bubble(
        parent,
        [...stack, parent],
        updateSet,
        boundaries,
        firstInvalidatedBy,
        traversedModules,
      )
      if (fullReload) return fullReload
    }
  }

  handlePush(payload: FbmUpdatePayload): void {
    this.applyQueue = this.applyQueue
      .then(() => this.applyPush(payload))
      .catch((err) => {
        // Keep the apply queue alive on a rejected apply. The error already surfaced
        // (an eval throw inside a factory is the app's own runtime error — never
        // caught or classified here).
        this.warnFailedUpdate(err, payload.changedIds)
      })
  }

  invalidateLocally(id: string, message?: string): void {
    this.logger.debug(`invalidate ${id}${message ? `: ${message}` : ''}`)
    this.applyQueue = this.applyQueue
      .then(() => this.applyInvalidate(id))
      .catch((err) => {
        this.warnFailedUpdate(err, id)
      })
  }

  handleModuleCacheRemoval(id: string): void {
    const data = {}
    const disposer = this.disposeMap.get(id)
    if (disposer) {
      disposer(data)
    }
    this.dataMap.set(id, data)
  }

  private async applyPush({
    changedIds,
    url,
    seq,
  }: FbmUpdatePayload): Promise<void> {
    if (seq !== this.lastSeq + 1) {
      // deltas only mean something in ship order; a gap means the record is wrong
      this.requestFullReload(
        `hmr update sequence gap (expected ${this.lastSeq + 1}, got ${seq})`,
      )
      return
    }
    this.lastSeq = seq

    const update = this.computeHmrUpdate(changedIds)
    if (update.type === 'noop') return
    if (update.type === 'full-reload') {
      this.requestFullReload(update.reason)
      return
    }

    const listenerPayload = this.toUpdatePayload(update.boundaries, undefined)
    await this.notifyListeners('vite:beforeUpdate', listenerPayload)
    if (this.options.beforeApply() === 'reload') return

    try {
      await import(/* @vite-ignore */ this.options.base + url)
    } catch {
      this.requestFullReload(`failed to import hmr patch ${url}`)
      return
    }

    await this.applyUpdate(update)
    await this.notifyListeners('vite:afterUpdate', listenerPayload)
  }

  private async applyInvalidate(id: string): Promise<void> {
    const firstInvalidatedBy = this.currentFirstInvalidatedBy ?? id
    const importers = this.runtime
      .getImporters(id)
      .filter((p) => this.runtime.isExecuted(p))
    if (!importers.length) {
      this.requestFullReload(
        `no importers to handle \`import.meta.hot.invalidate()\` called by \`${id}\``,
      )
      return
    }

    // No rebuild happened, so there is nothing to fetch: the walk runs on the current
    // rows and the apply re-runs from resident factories or reloads.
    const update = this.computeHmrUpdate(importers, { firstInvalidatedBy })
    if (update.type === 'noop') return
    if (update.type === 'full-reload') {
      this.requestFullReload(update.reason)
      return
    }

    const listenerPayload = this.toUpdatePayload(
      update.boundaries,
      firstInvalidatedBy,
    )
    await this.notifyListeners('vite:beforeUpdate', listenerPayload)
    if (this.options.beforeApply() === 'reload') return
    await this.applyUpdate(update, firstInvalidatedBy)
    await this.notifyListeners('vite:afterUpdate', listenerPayload)
  }

  private async applyUpdate(
    update: Extract<HmrUpdate, { type: 'boundaries' }>,
    firstInvalidatedBy?: string,
  ): Promise<void> {
    for (const id of update.updateSet) {
      if (!this.runtime.hasFactory(id)) {
        this.requestFullReload(`no factory for module \`${id}\``)
        return
      }
    }

    // old callbacks
    const applies = update.boundaries.map(([boundary, acceptedVia]) => ({
      boundary,
      acceptedVia,
      callbacks:
        this.hotModulesMap
          .get(boundary)
          ?.callbacks.filter((c) => c.deps.includes(acceptedVia)) ?? [],
    }))

    for (const id of update.updateSet) {
      this.runtime.removeModuleCache(id)
    }

    for (const { boundary, acceptedVia, callbacks } of applies) {
      this.runtime.initModule(acceptedVia)
      const fresh = this.runtime.loadExports(acceptedVia)
      try {
        this.currentFirstInvalidatedBy = firstInvalidatedBy
        for (const { deps, fn } of callbacks) {
          fn(
            deps.map((dep) =>
              dep === acceptedVia ? (fresh as any) : undefined,
            ),
          )
        }
      } finally {
        this.currentFirstInvalidatedBy = undefined
      }
      this.logger.debug(
        `hot updated: ${boundary === acceptedVia ? boundary : `${acceptedVia} via ${boundary}`
        }`,
      )
    }
  }

  private toUpdatePayload(
    boundaries: [string, string][],
    firstInvalidatedBy: string | undefined,
  ): UpdatePayload {
    // the public `vite:beforeUpdate` / `vite:afterUpdate` surface still speaks
    // per-boundary `Update`s — synthesized from the walk instead of server-sent
    const updates: Update[] = boundaries.map(([boundary, acceptedVia]) => ({
      type: 'js-update',
      path: boundary,
      acceptedPath: acceptedVia,
      timestamp: Date.now(),
      firstInvalidatedBy,
    }))
    return { type: 'update', updates }
  }

  private requestFullReload(reason: string): void {
    this.logger.debug(`full reload: ${reason}`)
    this.options.pageReload()
  }
}

/**
 * The FBM hot context: identical surface to the shared one, except `invalidate` is
 * handled fully client-side — a re-walk from the invalidator's importers — instead of
 * a `vite:invalidate` round-trip.
 */
export class FbmHMRContext extends HMRContext {
  constructor(
    private fbmClient: FbmHMRClient,
    private owner: string,
  ) {
    super(fbmClient, owner)
  }

  override invalidate(message: string): void {
    this.fbmClient.notifyListeners('vite:invalidate', {
      path: this.owner,
      message,
      firstInvalidatedBy:
        this.fbmClient.currentFirstInvalidatedBy ?? this.owner,
    })
    this.fbmClient.invalidateLocally(this.owner, message)
  }
}
