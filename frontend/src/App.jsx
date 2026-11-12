import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import CropHealth from './pages/CropHealth'
import SoilHealth from './pages/SoilHealth'

// The leaf classifier carries TensorFlow.js (~1 MB), so it is only fetched
// when someone actually opens the Leaf check tab.
const LeafCheck = lazy(() => import('./pages/LeafCheck'))

/**
 * The product has two jobs: show how the crop is doing and how the soil is
 * doing. Everything that used to live here (NDVI tooling, satellite search,
 * computer-vision playground, agronomy models, results browser) is superseded
 * for the farmer-facing app; the API still exposes those capabilities.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/crop-health" replace />} />
        <Route path="crop-health" element={<CropHealth />} />
        <Route path="soil-health" element={<SoilHealth />} />
        <Route
          path="leaf-check"
          element={
            <Suspense
              fallback={
                <div className="loading">
                  <span className="spinner" />
                  Loading the leaf checker…
                </div>
              }
            >
              <LeafCheck />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/crop-health" replace />} />
      </Route>
    </Routes>
  )
}
