use std::net::SocketAddr;

use crate::error::AppError;

/// Server settings, read from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    /// `json` or `pretty`.
    pub log_format: LogFormat,
    /// GitHub sign-in. `None` until `GITHUB_CLIENT_ID` and
    /// `GITHUB_CLIENT_SECRET` are both set; sign-in routes then answer 500.
    pub github: Option<GithubOAuth>,
    /// GitHub App (install flow, installation tokens). `None` until
    /// `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and a private key are set.
    pub github_app: Option<GithubApp>,
}

/// GitHub App settings. The `*_url` fields exist so tests can point at a mock
/// GitHub.
#[derive(Clone)]
pub struct GithubApp {
    pub app_id: String,
    /// The app's URL name: `https://github.com/apps/<slug>`.
    pub slug: String,
    /// RSA private key in PEM form, used to sign the app's JWTs.
    pub private_key: String,
    /// Secret GitHub signs webhook deliveries with. Read here so one place
    /// holds all app settings; the webhook handler uses it.
    pub webhook_secret: Option<String>,
    /// `https://github.com` unless overridden by `GITHUB_OAUTH_URL`.
    pub web_url: String,
    /// `https://api.github.com` unless overridden by `GITHUB_API_URL`.
    pub api_url: String,
}

impl std::fmt::Debug for GithubApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubApp")
            .field("app_id", &self.app_id)
            .field("slug", &self.slug)
            .field("private_key", &"<redacted>")
            .field(
                "webhook_secret",
                &self.webhook_secret.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// GitHub OAuth app settings. The two `*_url` fields exist so tests can point
/// at a mock GitHub.
#[derive(Debug, Clone)]
pub struct GithubOAuth {
    pub client_id: String,
    pub client_secret: String,
    /// Where users reach the app (the web dev server proxies `/api`); the
    /// OAuth callback is `<public_url>/api/auth/github/callback`.
    pub public_url: String,
    /// `https://github.com` unless overridden by `GITHUB_OAUTH_URL`.
    pub oauth_url: String,
    /// `https://api.github.com` unless overridden by `GITHUB_API_URL`.
    pub api_url: String,
    /// Set the `Secure` cookie flag (on when `public_url` is https).
    pub secure_cookies: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Json,
    Pretty,
}

impl Config {
    /// `DATABASE_URL` is required. `BIND_ADDR` defaults to `127.0.0.1:8080`
    /// (`PORT` alone overrides the port). `LOG_FORMAT` defaults to `pretty`.
    pub fn from_env() -> Result<Self, AppError> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, AppError> {
        let database_url = get("DATABASE_URL")
            .ok_or_else(|| AppError::Config("DATABASE_URL is not set".into()))?;
        let bind = match (get("BIND_ADDR"), get("PORT")) {
            (Some(a), _) => a,
            (None, Some(p)) => format!("127.0.0.1:{p}"),
            (None, None) => "127.0.0.1:8080".into(),
        };
        let bind_addr = bind
            .parse()
            .map_err(|e| AppError::Config(format!("invalid bind address {bind:?}: {e}")))?;
        let log_format = match get("LOG_FORMAT").as_deref() {
            None | Some("pretty") => LogFormat::Pretty,
            Some("json") => LogFormat::Json,
            Some(other) => {
                return Err(AppError::Config(format!(
                    "LOG_FORMAT must be json or pretty, got {other:?}"
                )))
            }
        };
        let non_empty = |k: &str| get(k).filter(|v| !v.trim().is_empty());
        let github = match (
            non_empty("GITHUB_CLIENT_ID"),
            non_empty("GITHUB_CLIENT_SECRET"),
        ) {
            (Some(client_id), Some(client_secret)) => {
                let public_url = get("PUBLIC_URL")
                    .unwrap_or_else(|| "http://localhost:5173".into())
                    .trim_end_matches('/')
                    .to_string();
                Some(GithubOAuth {
                    secure_cookies: public_url.starts_with("https://"),
                    client_id,
                    client_secret,
                    public_url,
                    oauth_url: get("GITHUB_OAUTH_URL")
                        .unwrap_or_else(|| "https://github.com".into()),
                    api_url: get("GITHUB_API_URL")
                        .unwrap_or_else(|| "https://api.github.com".into()),
                })
            }
            (None, None) => None,
            _ => {
                return Err(AppError::Config(
                    "set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither".into(),
                ))
            }
        };
        let github_app = github_app_from_lookup(&get)?;
        Ok(Self {
            database_url,
            bind_addr,
            log_format,
            github,
            github_app,
        })
    }
}

/// `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and the key (`GITHUB_APP_PRIVATE_KEY`,
/// or `GITHUB_APP_PRIVATE_KEY_PATH` to a .pem file) go together: all or none.
/// `\n` in `GITHUB_APP_PRIVATE_KEY` is turned into a newline so the key fits
/// on one line of a `.env` file.
fn github_app_from_lookup(
    get: &impl Fn(&str) -> Option<String>,
) -> Result<Option<GithubApp>, AppError> {
    let non_empty = |k: &str| get(k).filter(|v| !v.trim().is_empty());
    let key = match (
        non_empty("GITHUB_APP_PRIVATE_KEY"),
        non_empty("GITHUB_APP_PRIVATE_KEY_PATH"),
    ) {
        (Some(k), _) => Some(k.replace("\\n", "\n")),
        (None, Some(path)) => Some(std::fs::read_to_string(&path).map_err(|e| {
            AppError::Config(format!(
                "cannot read GITHUB_APP_PRIVATE_KEY_PATH {path:?}: {e}"
            ))
        })?),
        (None, None) => None,
    };
    let (app_id, slug) = (non_empty("GITHUB_APP_ID"), non_empty("GITHUB_APP_SLUG"));
    let (Some(app_id), Some(slug), Some(private_key)) = (app_id.clone(), slug.clone(), key.clone())
    else {
        if app_id.is_none() && slug.is_none() && key.is_none() {
            return Ok(None);
        }
        return Err(AppError::Config(
            "set GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_PRIVATE_KEY (or _PATH), or none of them"
                .into(),
        ));
    };
    jsonwebtoken::EncodingKey::from_rsa_pem(private_key.as_bytes()).map_err(|e| {
        AppError::Config(format!("GITHUB_APP_PRIVATE_KEY is not an RSA PEM key: {e}"))
    })?;
    Ok(Some(GithubApp {
        app_id,
        slug,
        private_key,
        webhook_secret: non_empty("GITHUB_WEBHOOK_SECRET"),
        web_url: get("GITHUB_OAUTH_URL").unwrap_or_else(|| "https://github.com".into()),
        api_url: get("GITHUB_API_URL").unwrap_or_else(|| "https://api.github.com".into()),
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn cfg(pairs: &'static [(&'static str, &'static str)]) -> Result<Config, AppError> {
        Config::from_lookup(|k| {
            pairs
                .iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.to_string())
        })
    }

    #[test]
    fn requires_database_url() {
        assert!(cfg(&[]).is_err());
    }

    #[test]
    fn defaults() {
        let c = cfg(&[("DATABASE_URL", "postgres://x")]).unwrap();
        assert_eq!(c.bind_addr.to_string(), "127.0.0.1:8080");
        assert_eq!(c.log_format, LogFormat::Pretty);
    }

    #[test]
    fn port_and_json_logs() {
        let c = cfg(&[
            ("DATABASE_URL", "postgres://x"),
            ("PORT", "9000"),
            ("LOG_FORMAT", "json"),
        ])
        .unwrap();
        assert_eq!(c.bind_addr.port(), 9000);
        assert_eq!(c.log_format, LogFormat::Json);
    }

    #[test]
    fn github_is_optional_but_all_or_nothing() {
        let c = cfg(&[("DATABASE_URL", "x")]).unwrap();
        assert!(c.github.is_none());
        assert!(cfg(&[("DATABASE_URL", "x"), ("GITHUB_CLIENT_ID", "id")]).is_err());
        let c = cfg(&[
            ("DATABASE_URL", "x"),
            ("GITHUB_CLIENT_ID", "id"),
            ("GITHUB_CLIENT_SECRET", "s"),
            ("PUBLIC_URL", "https://app.example/"),
        ])
        .unwrap();
        let g = c.github.unwrap();
        assert_eq!(g.public_url, "https://app.example");
        assert!(g.secure_cookies);
        assert_eq!(g.api_url, "https://api.github.com");
    }

    #[test]
    fn github_app_is_optional_but_all_or_nothing() {
        let c = cfg(&[("DATABASE_URL", "x")]).unwrap();
        assert!(c.github_app.is_none());
        assert!(cfg(&[("DATABASE_URL", "x"), ("GITHUB_APP_ID", "1")]).is_err());
        // Set, but the key is not a key.
        assert!(cfg(&[
            ("DATABASE_URL", "x"),
            ("GITHUB_APP_ID", "1"),
            ("GITHUB_APP_SLUG", "spectrace"),
            ("GITHUB_APP_PRIVATE_KEY", "not a key"),
        ])
        .is_err());
    }

    #[test]
    fn rejects_bad_values() {
        assert!(cfg(&[("DATABASE_URL", "x"), ("BIND_ADDR", "nope")]).is_err());
        assert!(cfg(&[("DATABASE_URL", "x"), ("LOG_FORMAT", "xml")]).is_err());
    }
}
