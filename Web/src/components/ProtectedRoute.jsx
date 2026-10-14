import { useAuth } from '../contexts/AuthContext.jsx'

/**
 * Wrap any route that requires a logged-in user:
 *   <Route path="/my-page" element={<ProtectedRoute><MyPage /></ProtectedRoute>} />
 *
 * Keeps auth branching out of individual pages — see the `auth-keycloak` doc
 * on the vantiq-vite MCP server.
 */
export default function ProtectedRoute({ children }) {
  const { isInitialized, isAuthenticated, initError, handleLogin } = useAuth()

  if (!isInitialized) {
    return <div>Initializing session...</div>
  }

  if (initError) {
    return <div>Authentication error: {initError}</div>
  }

  if (!isAuthenticated) {
    handleLogin()
    return <div>Redirecting to login...</div>
  }

  return children
}
