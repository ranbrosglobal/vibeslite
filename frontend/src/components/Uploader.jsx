import { assetUrl } from '../api'

/** File drop zone used by the upload flows (raster, GeoJSON, CSV, imagery). */
export default function Uploader({ onFiles, accept, multiple = false, label, hint, busy = false, children }) {
  const handleFiles = (fileList) => {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <label
      className="dropzone"
      onDragOver={(event) => {
        event.preventDefault()
        event.currentTarget.classList.add('drag')
      }}
      onDragLeave={(event) => event.currentTarget.classList.remove('drag')}
      onDrop={(event) => {
        event.preventDefault()
        event.currentTarget.classList.remove('drag')
        handleFiles(event.dataTransfer.files)
      }}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: 'none' }}
        disabled={busy}
        onChange={(event) => {
          handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{busy ? 'Uploading…' : label || 'Drop files or click to browse'}</div>
      <div>{hint}</div>
      {children}
    </label>
  )
}

/** Grid of generated assets with captions and download links. */
export function AssetGallery({ assets = [], titleKey = 'label', columns }) {
  if (!assets.length) return <div className="empty">No visual assets were generated.</div>
  return (
    <div className="image-grid" style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {assets.map((asset) => (
        <figure key={asset.name || asset.file} className="image-frame" style={{ margin: 0 }}>
          <img src={assetUrl(asset)} alt={asset[titleKey] || asset.name} loading="lazy" />
          <figcaption className="image-caption">
            <span>{asset[titleKey] || asset.name}</span>
            <a href={assetUrl(asset)} target="_blank" rel="noreferrer" download>
              download
            </a>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
