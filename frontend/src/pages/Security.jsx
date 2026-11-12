import { api, useApi } from '../api'
import { DataTable, Empty, JsonBlock, KeyValue, Loading, Notice, Panel, StatCard } from '../components/Panel'
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from '../components/MapView'

/**
 * Live security posture.
 *
 * The point of this page is that the hardened configuration is inspectable at
 * runtime rather than asserted in a README — including the parts that are not
 * solved (there is no user authentication in this build, and the page says so).
 */
export default function Security() {
  const posture = useApi(api.security)
  const health = useApi(api.health)
  const config = useApi(api.config)
  const geo = useApi(api.geoStatus)
  const data = posture.data

  if (posture.loading) return <Loading label="Reading the live security posture…" />
  if (posture.error) {
    return (
      <Notice tone="danger" title="Cannot read the posture">
        {posture.error.message}
      </Notice>
    )
  }
  if (!data) return <Empty title="No posture reported">The backend did not return a security posture.</Empty>

  const limits = data.rateLimits || {}
  const classification = data.classification || {}
  const disabled = Boolean(limits.disabled)

  return (
    <>
      <Notice tone={disabled ? 'warn' : 'muted'} title={disabled ? 'Rate limiting is currently disabled' : 'Rate limiting is active'}>
        Limits are counted per client address and evaluated per worker process. Behind multiple workers this is a
        per-process budget, not a global one — a shared store is the next step if you scale out.
      </Notice>

      <div className="grid cols-4">
        <StatCard label="Response headers" value={(data.headers || []).length} foot="applied to every response, including errors" tone="accent" />
        <StatCard label="Upload ceiling" value={data.uploadLimitMb} unit=" MB" foot="enforced before the body is read" />
        <StatCard label="Analysis budget" value={limits.analysis || '—'} foot={`${(classification.analysis || []).length} route prefixes`} />
        <StatCard
          label="Third-party origins"
          value={(geo.data?.providers?.find((provider) => provider.name === 'OSM raster tiles')?.hosts || []).length}
          unit=" tile hosts"
          foot="the only outside requests the browser makes, and only for map imagery"
          tone="green"
        />
      </div>

      <div className="grid sidebar-left">
        <Panel title="Rate limits" hint="Three tiers, so a heavy analysis cannot starve the UI">
          <KeyValue
            rows={[
              ['Read', limits.read],
              ['Write', limits.write],
              ['Analysis', limits.analysis],
              ['Scope', limits.scope],
              ['State', disabled ? 'disabled by environment' : 'enforced'],
            ]}
          />
        </Panel>

        <div className="stack">
          <Panel title="Response headers" hint="Sent on every response, error responses included">
            <div className="chips">
              {(data.headers || []).map((header) => (
                <span key={header} className="chip active">
                  {header}
                </span>
              ))}
            </div>
          </Panel>

          <Panel title="Content Security Policy" hint="No inline script, no external origin, framing denied">
            <KeyValue
              rows={[
                ['frame-ancestors', data.policy?.frameAncestors],
                ['object-src', data.policy?.objectSrc],
              ]}
            />
            <pre className="json">{data.policy?.csp}</pre>
          </Panel>
        </div>
      </div>

      <Panel title="Request classification" hint="Which bucket a route is counted against">
        <KeyValue
          rows={[
            ['Analysis prefixes', (classification.analysis || []).join(', ')],
            ['Write', classification.write],
            ['Read', classification.read],
          ]}
        />
      </Panel>

      <Panel title="Accepted file types" hint="Checked by extension before the upload is written to disk">
        <DataTable
          columns={[
            { key: 'kind', label: 'Kind' },
            { key: 'extensions', label: 'Extensions', render: (value) => (value || []).join(', ') },
            { key: 'count', label: 'Count' },
          ]}
          rows={Object.entries(data.extensionAllowLists || {}).map(([kind, extensions]) => ({
            kind,
            extensions,
            count: (extensions || []).length,
          }))}
          numericFrom={1}
        />
      </Panel>

      <Panel
        title="OpenStreetMap access"
        hint="Every map, place name and feature comes from OSM — and what that obliges us to do"
      >
        {geo.loading ? <Loading label="Reading the OSM posture…" /> : null}
        {geo.error ? <Notice tone="danger">{geo.error.message}</Notice> : null}
        {geo.data ? (
          <>
            <DataTable
              columns={[
                { key: 'name', label: 'Provider' },
                { key: 'role', label: 'Role' },
                { key: 'licence', label: 'Licence' },
                { key: 'policy', label: 'Terms we enforce' },
              ]}
              rows={geo.data.providers || []}
            />
            <KeyValue
              rows={[
                ['Enabled', geo.data.enabled],
                ['Tile hosts allowed by CSP', (geo.data.providers?.find((p) => p.name === 'OSM raster tiles')?.hosts || []).join(', ')],
                ['Attribution', OSM_ATTRIBUTION],
                ['Rate policy', `≤ ${geo.data.limits?.requests_per_second} request/s, spaced server-side`],
                ['Cache window', `${geo.data.limits?.cache_seconds}s`],
                ['Radius / feature cap', `${geo.data.limits?.max_radius_m} m · ${geo.data.limits?.max_features} features`],
                ['Upstream calls this process', geo.data.upstream_calls],
                ['Last provider error', geo.data.last_error || 'none'],
              ]}
            />
            <div className="hint">
              {geo.data.note}{' '}
              <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer noopener">
                OSM copyright and licence
              </a>{' '}
              — attribution is a licence condition, so the map credit is rendered, not just tucked into a tile URL.
            </div>
          </>
        ) : null}
      </Panel>

      <Panel title="Runtime configuration" hint="What the process is actually running with">
        <KeyValue
          rows={[
            ['Project', config.data?.project?.name],
            ['Version', config.data?.project?.version],
            ['CORS origins', Array.isArray(config.data?.api?.cors_origins) ? config.data.api.cors_origins.join(', ') : config.data?.api?.cors_origins],
            ['Analysis pixel cap', config.data?.analysis?.max_analysis_pixels],
            ['OpenCV engine', health.data?.capabilities ? (health.data.capabilities.opencv ? 'available' : 'unavailable') : undefined],
            ['Indices', health.data?.capabilities?.indices?.join(', ')],
            ['Agronomy models', health.data?.capabilities?.agronomy?.join(', ')],
          ]}
        />
      </Panel>

      <Notice tone="warn" title="Not solved in this build">
        {data.note} There is no multi-tenant isolation, no audit log and no secret store here: this is a field-station and
        demo deployment. Treat the honesty of that statement as part of the posture.
      </Notice>

      <Panel title="Raw posture payload" hint="The same JSON the API returns" flush>
        <JsonBlock value={data} />
      </Panel>
    </>
  )
}
