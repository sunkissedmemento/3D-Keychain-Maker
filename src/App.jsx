import KeychainApp from './KeychainApp'
import STLSlicer from './online-slicer/App'

const APPS = {
  keychain: KeychainApp,
  slicer: STLSlicer,
}

export default function App() {
  const app = new URLSearchParams(window.location.search).get('app') || 'keychain'
  const Component = APPS[app] ?? KeychainApp
  return <Component />
}