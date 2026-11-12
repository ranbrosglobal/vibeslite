# Vendored Leaflet (1.9.4)

`leaflet.js`, `leaflet.css` and `images/` are copied verbatim from the
`leaflet` npm package (Leaflet 1.9.4, BSD-2-Clause — see `LICENCE.txt`).

They are served from this directory instead of `unpkg.com` so that the console's
map has **no third-party script dependency**: the map still loads on a field
laptop with a restrictive network, and the Content-Security-Policy does not have
to allow an external script origin. Update by re-copying from
`frontend/node_modules/leaflet/dist/` (the version the dashboard already
bundles) and bumping this note.
