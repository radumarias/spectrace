use std::net::SocketAddr;

use crate::error::AppError;

/// Server settings, read from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    /// `json` or `pretty`.
    pub log_format: LogFormat,
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
        Ok(Self {
            database_url,
            bind_addr,
            log_format,
        })
    }
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
    fn rejects_bad_values() {
        assert!(cfg(&[("DATABASE_URL", "x"), ("BIND_ADDR", "nope")]).is_err());
        assert!(cfg(&[("DATABASE_URL", "x"), ("LOG_FORMAT", "xml")]).is_err());
    }
}
