import { nanoid } from 'nanoid/non-secure'
import type { DevRuntime as DevRuntimeType } from 'rolldown/experimental/runtime-types'
import { FbmHMRClient, FbmHMRContext } from './fbmHmrClient'
import {
  base,
  clearOverlayOrReloadOnFirstUpdate,
  pageReload,
  registerFbmClient,
  removeStyle,
  transport,
  updateStyle,
} from './client'

// The full-bundle-mode (FBM) client entry. It reuses the entire base client — transport,
// message handling, overlay, CSS — by importing `./client` (whose module body runs the
// boot as a side effect), then layers the FBM HMR judgment on top: the rolldown runtime
// subclass, the `FbmHMRClient` walk/apply, and the runtime hooks.
//
// This entry is built to `dist/client/fbmClient.mjs` and is only ever inlined into the
// bundle (via `getHmrImplementation`) when `experimental.bundledDev` is enabled. The plain
// `dist/client/client.mjs` served as `/@vite/client` never reaches this file, so non-FBM
// dev pages carry none of the FBM code.

// Preserve the public export surface of the inlined runtime module (same as `client.ts`),
// since the FBM build replaces `client.mjs` as the inlined client.
export {
  createHotContext,
  injectQuery,
  removeStyle,
  updateStyle,
  ErrorOverlay,
} from './client'

// injected by rolldown's hmr plugin into the bundle prelude, ahead of this client
declare const DevRuntime: typeof DevRuntimeType

if (typeof DevRuntime !== 'undefined') {
  class ViteDevRuntime extends DevRuntime {
    override createModuleHotContext(moduleId: string) {
      const ctx = new FbmHMRContext(fbmHmrClient, moduleId)
      // @ts-expect-error TODO: support CSS properly
      ctx._internal = { updateStyle, removeStyle }
      return ctx
    }
  }

  const clientId = nanoid()

  // the client-connect hello: identification only (binds this socket to a clientId and
  // creates the server-side session) — no execution state ever travels upstream
  transport.send({
    type: 'custom',
    event: 'vite:client-connected',
    data: { clientId },
  })

  const runtime = ((globalThis as any).__rolldown_runtime__ ??=
    new ViteDevRuntime(clientId))

  const fbmHmrClient = new FbmHMRClient(
    {
      error: (err) => console.error('[vite]', err),
      debug: (...msg) => console.debug('[vite]', ...msg),
    },
    transport,
    runtime,
    {
      base,
      beforeApply: clearOverlayOrReloadOnFirstUpdate,
      pageReload,
    },
  )
  // route every payload notification (`fbm-update`, listener events) to this client
  registerFbmClient(fbmHmrClient)

  // the runtime is a store + executor; every HMR judgment lives behind these hooks
  runtime.hooks = {
    createModuleHotContext: (id: string) => runtime.createModuleHotContext(id),
    onModuleCacheRemoval: (id: string) =>
      fbmHmrClient.handleModuleCacheRemoval(id),
  }
}
