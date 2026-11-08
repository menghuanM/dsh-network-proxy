/**
 * dsh-network-proxy — browser half.
 *
 * Contributes one settings row to the General section (`settings.general.item`
 * id `network-proxy`): the three-mode egress switch — follow system / manual
 * proxy / direct — with the manual endpoint field and a live status line.
 *
 * Data flows over the plugin's own same-origin `/api/network-proxy` routes
 * rather than a typed remote binding: those routes are served by the same host
 * process on every kernel line, and the write path (POST `/apply`) is exactly
 * the one the host half owns.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables
 * so the row survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: '@menghuanm/dsh-network-proxy',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef } = React

    const NS = 'settings.networkProxy'
    const API = '/api/network-proxy'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        'row.title': '网络代理',
        'row.description': '配置 DeepSeek Harness 的出站网络代理，修改后立即生效',
        'mode.system': '跟随系统',
        'mode.manual': '手动代理',
        'mode.direct': '直连',
        'manual.placeholder': 'http://127.0.0.1:7890',
        'manual.apply': '应用',
        'status.active': '已生效',
        'status.saving': '正在应用…',
        'status.pending': '填写地址后点击「应用」生效',
        'manual.cancel': '取消',
        'status.error': '应用失败',
        'status.offline': '插件后端不可用，重启应用后重试',
        'status.retry': '重试',
        'system.none': '系统未启用代理（当前直连）',
        'system.active': '系统代理：{url}',
      },
      en: {
        'row.title': 'Network proxy',
        'row.description': 'Configure how DeepSeek Harness reaches the network; changes apply immediately',
        'mode.system': 'Follow system',
        'mode.manual': 'Manual proxy',
        'mode.direct': 'Direct',
        'manual.placeholder': 'http://127.0.0.1:7890',
        'manual.apply': 'Apply',
        'status.active': 'Active',
        'status.saving': 'Applying…',
        'status.pending': 'Enter an address, then Apply',
        'manual.cancel': 'Cancel',
        'status.error': 'Apply failed',
        'status.offline': 'Plugin backend unavailable; restart the app and retry',
        'status.retry': 'Retry',
        'system.none': 'No system proxy enabled (direct now)',
        'system.active': 'System proxy: {url}',
      },
    }

    const CSS = [
      '.dshNetProxyRow{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:14px;padding:16px 0}',
      '.dshNetProxyHeader{display:flex;align-items:flex-start;gap:24px}',
      '.dshNetProxyCopy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}',
      '.dshNetProxyTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.dshNetProxyDesc,.dshNetProxyStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshNetProxyStatus[data-error=true]{color:var(--dsw-alias-state-error-primary)}',
      '.dshNetProxyModes{display:grid;grid-template-columns:repeat(3,minmax(72px,1fr));flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px;background:var(--dsw-alias-bg-module-platform)}',
      '.dshNetProxyMode{height:30px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.dshNetProxyMode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshNetProxyMode[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}',
      '.dshNetProxyMode:disabled{cursor:default;opacity:.6}',
      '.dshNetProxyManual{display:flex;align-items:center;gap:8px;padding-left:0}',
      '.dshNetProxyInput{box-sizing:border-box;flex:1;min-width:0;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-input);color:var(--dsw-alias-label-primary);padding:0 11px;font:inherit;font-size:13px;outline:none}',
      '.dshNetProxyInput:focus{border-color:var(--dsw-alias-border-primary)}',
      '.dshNetProxyApply{height:36px;border:0;border-radius:8px;padding:0 14px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.dshNetProxyApply:disabled{cursor:default;opacity:.55}',
      '.dshNetProxyCancel{height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.dshNetProxyCancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshNetProxyCancel:disabled{cursor:default;opacity:.55}',
      '@media(max-width:680px){.dshNetProxyHeader{flex-direction:column;gap:12px}.dshNetProxyModes{width:100%}.dshNetProxyManual{align-items:stretch;flex-direction:column}.dshNetProxyApply,.dshNetProxyCancel{align-self:flex-end}}',
    ].join('\n')

    /**
     * Minimal snapshot store: clone-on-update semantics so React's
     * `useSyncExternalStore` can diff referentially.
     *
     * @param {object} initial
     */
    function createSnapshotStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        update(recipe) {
          const next = { ...state }
          recipe(next)
          state = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    async function fetchJson(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * Owns the row's view state and the round trips to the plugin backend.
     * `generation` makes a late response from a superseded load/save drop
     * instead of clobbering the newer state.
     */
    class NetworkProxyController {
      constructor() {
        this.generation = 0
        this.store = createSnapshotStore({
          status: 'idle',
          error: null,
          mode: 'system',
          url: '',
          systemProxy: null,
          // The mode the host actually runs; `mode` may differ while the
          // manual editor is staged.
          appliedMode: 'system',
          pending: false,
        })
      }

      async load() {
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        try {
          const payload = await fetchJson('')
          if (generation !== this.generation) return
          this.store.update((state) => {
            // Server-side status maps onto row states: a refused activation
            // (dead endpoint, degraded backend) must surface as an error with
            // its reason instead of masquerading as "active".
            state.status = payload.status === 'error' ? 'error' : payload.status === 'idle' ? 'idle' : 'ready'
            state.error = payload.status === 'error' && typeof payload.error === 'string' && payload.error !== ''
              ? payload.error
              : null
            state.mode = payload.mode ?? 'system'
            state.url = typeof payload.url === 'string' ? payload.url : ''
            state.systemProxy = payload.systemProxy ?? null
            // A fresh read is authoritative: it clears any staged editor.
            state.appliedMode = payload.mode ?? 'system'
            state.pending = false
          })
        } catch (error) {
          if (generation !== this.generation) return
          this.store.update((state) => {
            state.status = 'offline'
            state.error = null
          })
        }
      }

      async save(mode, url) {
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'saving'; state.error = null })
        try {
          const payload = await fetchJson('/apply', {
            method: 'POST',
            body: JSON.stringify(mode === 'manual' ? { mode, url } : { mode }),
          })
          if (generation !== this.generation) return
          this.store.update((state) => {
            state.status = 'ready'
            state.mode = payload.mode ?? mode
            state.url = typeof payload.url === 'string' ? payload.url : ''
            state.systemProxy = payload.systemProxy ?? null
            state.appliedMode = payload.mode ?? mode
            state.pending = false
          })
        } catch (error) {
          if (generation !== this.generation) return
          this.store.update((state) => {
            state.status = 'error'
            state.error = error instanceof Error ? error.message : String(error)
          })
        }
      }

      /**
       * Switch to the manual row *without committing anything*.
       *
       * Manual mode is the one mode that needs a value the user must type
       * first, so selecting it is not an apply: posting `{mode:'manual'}`
       * with no URL would be rejected by the host (`Manual proxy requires a
       * URL`) and bounce the row back to the previous mode. Selecting it only
       * stages the editor; `save('manual', url)` commits once a URL exists.
       */
      stageManual() {
        this.generation += 1
        this.store.update((state) => {
          state.status = 'ready'
          state.error = null
          // Remember what the host is actually running so an abandoned
          // editor can go back to it; `pending` marks this row as uncommitted.
          state.appliedMode = state.mode
          state.mode = 'manual'
          state.pending = true
        })
      }

      /** Abandon the staged manual editor and return to the applied mode. */
      stageCancel() {
        this.generation += 1
        this.store.update((state) => {
          state.status = 'ready'
          state.error = null
          state.mode = state.appliedMode ?? 'system'
          state.pending = false
        })
      }

      dispose() {
        this.generation += 1
      }
    }

    function NetworkProxyRow({ controller, t }) {
      const state = React.useSyncExternalStore(
        (listener) => controller.store.subscribe(listener),
        () => controller.store.getSnapshot(),
        () => controller.store.getSnapshot(),
      )
      const [draft, setDraft] = useState(state.url)
      const mounted = useRef(false)

      useEffect(() => {
        if (!mounted.current) {
          mounted.current = true
          controller.load()
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') controller.load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [controller])

      useEffect(() => { setDraft(state.url) }, [state.url])

      const busy = state.status === 'loading' || state.status === 'saving'
      const disabled = busy
      /**
       * `manual` is staged, every other mode is applied straight away.
       *
       * Applying manually only makes sense once a URL exists; selecting the
       * tab first is what lets the user type one. `appliedMode` tracks the
       * mode the host actually has, so abandoning the manual editor can put
       * the row back where it was.
       */
      const choose = (mode) => {
        if (mode === state.mode || disabled || state.status === 'offline') return
        if (mode === 'manual') {
          controller.stageManual()
          return
        }
        controller.save(mode)
      }
      /** Leave the manual editor without committing anything. */
      const cancelManual = () => {
        controller.stageCancel()
      }
      const statusText = state.status === 'offline'
        ? t('status.offline')
        : state.error !== null
          ? `${t('status.error')}: ${state.error}`
          : state.status === 'saving'
            ? t('status.saving')
            : state.status === 'ready' && state.pending
              ? t('status.pending')
              : state.status === 'ready'
                ? t('status.active')
                : ''
      const systemLine = state.status === 'ready' && state.mode === 'system'
        ? (state.systemProxy?.httpProxy ?? state.systemProxy?.httpsProxy)
          ? t('system.active').replace('{url}', state.systemProxy.httpProxy ?? state.systemProxy.httpsProxy)
          : t('system.none')
        : ''

      return h('div', { className: 'dshNetProxyRow' },
        h('div', { className: 'dshNetProxyHeader' },
          h('div', { className: 'dshNetProxyCopy' },
            h('div', { className: 'dshNetProxyTitle' }, t('row.title')),
            h('div', { className: 'dshNetProxyDesc' }, t('row.description')),
            systemLine !== '' && h('div', { className: 'dshNetProxyDesc' }, systemLine),
            statusText !== '' && h('div', {
              className: 'dshNetProxyStatus',
              'data-error': state.error !== null,
              role: state.error !== null ? 'alert' : undefined,
            }, statusText),
          ),
          h('div', { className: 'dshNetProxyModes', role: 'radiogroup', 'aria-label': t('row.title') },
            ['system', 'manual', 'direct'].map((mode) => h('button', {
              key: mode,
              type: 'button',
              role: 'radio',
              'aria-checked': state.mode === mode,
              'data-active': state.mode === mode,
              className: 'dshNetProxyMode',
              disabled,
              onClick: () => choose(mode),
            }, t(`mode.${mode}`))),
          ),
        ),
        state.mode === 'manual' && h('form', {
          className: 'dshNetProxyManual',
          onSubmit: (event) => {
            event.preventDefault()
            // Nothing to apply until a URL is actually typed: submitting an
            // empty field is what used to post `{mode:'manual'}` and get
            // refused by the host.
            if (disabled || state.status === 'offline' || draft.trim() === '') return
            controller.save('manual', draft.trim())
          },
        },
          h('input', {
            className: 'dshNetProxyInput',
            type: 'url',
            value: draft,
            placeholder: t('manual.placeholder'),
            disabled,
            required: true,
            pattern: 'https?://.*',
            'aria-label': t('mode.manual'),
            autoFocus: state.pending,
            onChange: (event) => setDraft(event.target.value),
          }),
          h('button', {
            className: 'dshNetProxyApply',
            type: 'submit',
            // Only a genuinely new, non-empty value can be applied; an
            // unchanged URL is already live.
            disabled: disabled || state.status === 'offline' || draft.trim() === '' || (!state.pending && draft.trim() === state.url),
          }, t('manual.apply')),
          h('button', {
            className: 'dshNetProxyCancel',
            type: 'button',
            disabled,
            onClick: () => cancelManual(),
          }, t('manual.cancel')),
        ),
        state.status === 'offline' && h('button', {
          type: 'button',
          className: 'dshNetProxyApply',
          onClick: () => controller.load(),
        }, t('status.retry')),
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'network-proxy: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-network-proxy')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'network-proxy: styles')

      const controller = new NetworkProxyController()
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'network-proxy',
        order: -10,
        locale: NS,
      }, () => h(NetworkProxyRow, { controller, t })))
      ctx.effect(() => () => controller.dispose(), 'network-proxy: controller')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.name = 'network-proxy'
    return module.exports
  },
})
