import { createContext, useContext, useEffect, useRef, useState } from 'react'
import Keycloak from 'keycloak-js'
import Vantiq from '../services/vantiq'

// vantiqPublic is the standard Vantiq public OIDC client, the same on every realm.
// Overridable only for a non-standard Keycloak setup.
const OAUTH_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'vantiqPublic'

if (!import.meta.env.VITE_KEYCLOAK_URL) {
  throw new Error('Missing required env var: VITE_KEYCLOAK_URL — add it to .env.local')
}
if (!import.meta.env.VITE_KEYCLOAK_REALM) {
  throw new Error('Missing required env var: VITE_KEYCLOAK_REALM — add it to .env.local')
}

const KEYCLOAK_BASE_URL = import.meta.env.VITE_KEYCLOAK_URL
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM
// Return to the app's index.html after auth, not the origin root — the root is the
// Vantiq portal, which drops the user into their session's namespace. Vantiq serves
// documents by exact name with no directory index, so the redirect must name
// index.html explicitly. BASE_URL is Vite's configured `base` (/ui/docs/NS/<ns>/web/
// for a vantiq build, / for dev), always trailing-slashed.
const REDIRECT_URI =
  import.meta.env.VITE_REDIRECT_URI ||
  `${window.location.origin}${import.meta.env.BASE_URL}index.html`
const SILENT_CHECK_SSO_URI = import.meta.env.VITE_SILENT_CHECK_SSO_URI || undefined

const AuthContext = createContext(null)

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export const AuthProvider = ({ children }) => {
  const [isInitialized, setIsInitialized] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [profile, setProfile] = useState(null)
  const [initError, setInitError] = useState('')
  const [actionError, setActionError] = useState('')
  const keycloakRef = useRef(null)
  const initStartedRef = useRef(false)

  if (!keycloakRef.current) {
    keycloakRef.current = new Keycloak({
      url: KEYCLOAK_BASE_URL,
      realm: KEYCLOAK_REALM,
      clientId: OAUTH_CLIENT_ID,
    })
  }

  const keycloak = keycloakRef.current

  useEffect(() => {
    // Guard against React StrictMode's double-invocation — only init once.
    // No isMounted/cleanup guard: this effect runs exactly once (ref guard
    // above), so a StrictMode simulated unmount would flip the flag and
    // permanently suppress these state updates. The provider never really
    // unmounts.
    if (initStartedRef.current) return
    initStartedRef.current = true

    const initPromise = keycloak.init({
      onLoad: 'check-sso',
      pkceMethod: 'S256',
      responseMode: 'query',
      redirectUri: REDIRECT_URI,
      silentCheckSsoRedirectUri: SILENT_CHECK_SSO_URI,
      checkLoginIframe: false,
    })

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Keycloak init timed out.')), 10000)
    })

    initPromise
      .then((authenticated) => {
        setIsAuthenticated(authenticated)
        if (authenticated) {
          setInitError('')
          Vantiq.setAccessToken(keycloak.token)
          Vantiq.setTokenProvider(async () => {
            try {
              await keycloak.updateToken(30)
            } catch {
              // fall through — the request proceeds with the current token
            }
            return keycloak.token
          })
          setupTokenRefresh(keycloak)
          keycloak
            .loadUserProfile()
            .then((userProfile) => setProfile(userProfile))
            .catch(() => setProfile(null))
        }
      })
      .catch(() => {
        // handled by the Promise.race catch below
      })

    Promise.race([initPromise, timeoutPromise])
      .then(() => setIsInitialized(true))
      .catch((error) => {
        setInitError(error?.message || 'Failed to initialize Keycloak. Check the auth URL and realm.')
        setIsInitialized(true)
      })
  }, [])

  const handleLogin = () => {
    setActionError('')
    keycloak.login({ redirectUri: REDIRECT_URI }).catch(() => setActionError('Login failed. Please try again.'))
  }

  const handleLogout = () => {
    setActionError('')
    keycloak.logout({ redirectUri: REDIRECT_URI }).catch(() => setActionError('Logout failed. Please try again.'))
  }

  const value = {
    keycloak,
    isInitialized,
    isAuthenticated,
    profile,
    initError,
    actionError,
    handleLogin,
    handleLogout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function setupTokenRefresh(keycloak) {
  keycloak.onTokenExpired = () => {
    keycloak
      .updateToken(30)
      .then((refreshed) => {
        if (refreshed) Vantiq.setAccessToken(keycloak.token)
      })
      .catch(() => {
        keycloak.login()
      })
  }
}
