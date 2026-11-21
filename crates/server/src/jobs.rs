//! Job queue (T1.5).
//!
//! Runners pull work from here. A job is `queued`, then `running` while a
//! worker holds it and keeps sending heartbeats, then `succeeded` or `failed`.
//! Claiming uses `FOR UPDATE SKIP LOCKED`, so two workers never get the same
//! row. A failed attempt goes back to `queued` with a back-off until
//! `max_attempts` is used up. A running job whose worker stopped sending
//! heartbeats is put back the same way by [`reap_stale`].
//!
//! Every state change appends a row to `job_events` in the same transaction.
//! The per-project server-sent events stream reads that table, so it also
//! works when several server processes share one database.

use std::{collections::VecDeque, convert::Infallible, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgConnection, PgPool};
use uuid::Uuid;

use crate::{AppError, AppState};

pub const QUEUED: &str = "queued";
pub const RUNNING: &str = "running";
pub const SUCCEEDED: &str = "succeeded";
pub const FAILED: &str = "failed";

pub const DEFAULT_MAX_ATTEMPTS: i32 = 3;
/// A running job with no heartbeat for this long is handed to another worker.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
/// How often the server looks for jobs whose worker went quiet.
pub const REAP_INTERVAL: Duration = Duration::from_secs(15);
/// How often an open event stream looks for new events.
const STREAM_POLL: Duration = Duration::from_millis(500);
const STREAM_BATCH: i64 = 100;
/// Serialises event inserts so ids become visible in order (see `record_event`).
const EVENT_LOCK_KEY: i64 = 0x5350_4543; // "SPEC"

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Job {
    pub id: Uuid,
    pub project_id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub status: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub run_at: DateTime<Utc>,
    pub claimed_by: Option<String>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct JobEvent {
    pub id: i64,
    pub project_id: Uuid,
    pub job_id: Uuid,
    pub event: String,
    pub data: Value,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/// Append an event. Takes a transaction-scoped advisory lock first so that
/// event ids are committed in id order: without it, a reader that already saw
/// id 7 could miss id 6 committed a moment later. Transactions take their row
/// locks before this one, so the lock cannot deadlock.
async fn record_event(
    conn: &mut PgConnection,
    job: &Job,
    event: &str,
    data: Value,
) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(EVENT_LOCK_KEY)
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO job_events (project_id, job_id, event, data) VALUES ($1, $2, $3, $4)")
        .bind(job.project_id)
        .bind(job.id)
        .bind(event)
        .bind(data)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Add a job to the queue. `project_id` is not checked against a projects
/// table yet (T1.1 adds that).
pub async fn enqueue(
    db: &PgPool,
    project_id: Uuid,
    kind: &str,
    payload: Value,
    max_attempts: i32,
) -> Result<Job, AppError> {
    if kind.is_empty() || kind.len() > 64 {
        return Err(AppError::BadRequest(
            "kind must be 1 to 64 characters".into(),
        ));
    }
    if !(1..=10).contains(&max_attempts) {
        return Err(AppError::BadRequest(
            "max_attempts must be between 1 and 10".into(),
        ));
    }
    let mut tx = db.begin().await?;
    let job: Job = sqlx::query_as(
        "INSERT INTO jobs (project_id, kind, payload, max_attempts)
         VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(project_id)
    .bind(kind)
    .bind(payload)
    .bind(max_attempts)
    .fetch_one(&mut *tx)
    .await?;
    record_event(&mut tx, &job, "queued", json!({ "kind": job.kind })).await?;
    tx.commit().await?;
    Ok(job)
}

/// Claim the oldest runnable job, or `None` when there is nothing to do.
/// An empty `kinds` list accepts any kind.
pub async fn claim(
    db: &PgPool,
    worker_id: &str,
    kinds: &[String],
) -> Result<Option<Job>, AppError> {
    require_worker(worker_id)?;
    let mut tx = db.begin().await?;
    let job: Option<Job> = sqlx::query_as(
        "WITH next AS (
             SELECT id FROM jobs
             WHERE status = 'queued' AND run_at <= now()
               AND (cardinality($2::text[]) = 0 OR kind = ANY($2))
             ORDER BY run_at, created_at, id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         UPDATE jobs SET status = 'running', attempts = attempts + 1,
                claimed_by = $1, heartbeat_at = now(), started_at = now(),
                finished_at = NULL, error = NULL, updated_at = now()
         FROM next WHERE jobs.id = next.id
         RETURNING jobs.*",
    )
    .bind(worker_id)
    .bind(kinds)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(job) = &job {
        record_event(
            &mut tx,
            job,
            "started",
            json!({ "worker_id": worker_id, "attempt": job.attempts }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(job)
}

/// Prove the worker is alive. Fails with a conflict when the job is no longer
/// running under this worker (finished, or handed to someone else).
pub async fn heartbeat(db: &PgPool, id: Uuid, worker_id: &str) -> Result<Job, AppError> {
    let job: Option<Job> = sqlx::query_as(
        "UPDATE jobs SET heartbeat_at = now(), updated_at = now()
         WHERE id = $1 AND claimed_by = $2 AND status = 'running'
         RETURNING *",
    )
    .bind(id)
    .bind(worker_id)
    .fetch_optional(db)
    .await?;
    owned_or_conflict(db, id, job).await
}

/// Report progress. Counts as a heartbeat too.
pub async fn progress(
    db: &PgPool,
    id: Uuid,
    worker_id: &str,
    message: &str,
    data: Value,
) -> Result<Job, AppError> {
    let mut tx = db.begin().await?;
    let job: Option<Job> = sqlx::query_as(
        "UPDATE jobs SET heartbeat_at = now(), updated_at = now()
         WHERE id = $1 AND claimed_by = $2 AND status = 'running'
         RETURNING *",
    )
    .bind(id)
    .bind(worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(job) = job else {
        drop(tx);
        return owned_or_conflict(db, id, None).await;
    };
    record_event(
        &mut tx,
        &job,
        "progress",
        json!({ "message": message, "data": data }),
    )
    .await?;
    tx.commit().await?;
    Ok(job)
}

pub async fn complete(
    db: &PgPool,
    id: Uuid,
    worker_id: &str,
    result: Value,
) -> Result<Job, AppError> {
    let mut tx = db.begin().await?;
    let job: Option<Job> = sqlx::query_as(
        "UPDATE jobs SET status = 'succeeded', finished_at = now(),
                heartbeat_at = NULL, updated_at = now()
         WHERE id = $1 AND claimed_by = $2 AND status = 'running'
         RETURNING *",
    )
    .bind(id)
    .bind(worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(job) = job else {
        drop(tx);
        return owned_or_conflict(db, id, None).await;
    };
    record_event(&mut tx, &job, "succeeded", json!({ "result": result })).await?;
    tx.commit().await?;
    Ok(job)
}

/// Record a failed attempt. The job goes back to `queued` with a back-off
/// (5 s, 10 s, 20 s, ... capped at 5 min) unless it used all its attempts,
/// in which case it becomes `failed`.
pub async fn fail(db: &PgPool, id: Uuid, worker_id: &str, error: &str) -> Result<Job, AppError> {
    let mut tx = db.begin().await?;
    let job: Option<Job> = sqlx::query_as(&format!(
        "UPDATE jobs SET {RETRY_OR_FAIL}
         WHERE id = $1 AND claimed_by = $3 AND status = 'running'
         RETURNING *"
    ))
    .bind(id)
    .bind(error)
    .bind(worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(job) = job else {
        drop(tx);
        return owned_or_conflict(db, id, None).await;
    };
    record_retry_or_fail(&mut tx, &job, error).await?;
    tx.commit().await?;
    Ok(job)
}

/// Put running jobs whose last heartbeat is older than `timeout` back in the
/// queue (or fail them when out of attempts). Returns the affected jobs.
pub async fn reap_stale(db: &PgPool, timeout: Duration) -> Result<Vec<Job>, AppError> {
    const ERROR: &str = "worker stopped sending heartbeats";
    let mut tx = db.begin().await?;
    let jobs: Vec<Job> = sqlx::query_as(&format!(
        "UPDATE jobs SET {RETRY_OR_FAIL}
         WHERE id IN (
             SELECT id FROM jobs
             WHERE status = 'running'
               AND heartbeat_at < now() - make_interval(secs => $1)
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *"
    ))
    .bind(timeout.as_secs_f64())
    .bind(ERROR)
    .fetch_all(&mut *tx)
    .await?;
    for job in &jobs {
        record_retry_or_fail(&mut tx, job, ERROR).await?;
    }
    tx.commit().await?;
    Ok(jobs)
}

/// Shared SET clause for `fail` and `reap_stale`. Both bind the error text
/// as `$2`.
const RETRY_OR_FAIL: &str = "\
    status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, \
    run_at = CASE WHEN attempts < max_attempts \
        THEN now() + make_interval(secs => LEAST(300.0, 5.0 * power(2, attempts - 1))) \
        ELSE run_at END, \
    finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END, \
    claimed_by = NULL, heartbeat_at = NULL, updated_at = now(), \
    error = $2";

async fn record_retry_or_fail(
    conn: &mut PgConnection,
    job: &Job,
    error: &str,
) -> Result<(), AppError> {
    if job.status == QUEUED {
        record_event(
            conn,
            job,
            "retrying",
            json!({ "error": error, "attempt": job.attempts, "run_at": job.run_at }),
        )
        .await
    } else {
        record_event(
            conn,
            job,
            "failed",
            json!({ "error": error, "attempt": job.attempts }),
        )
        .await
    }
}

/// A mutating call matched no row: say why.
async fn owned_or_conflict(db: &PgPool, id: Uuid, job: Option<Job>) -> Result<Job, AppError> {
    if let Some(job) = job {
        return Ok(job);
    }
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    match status {
        None => Err(AppError::NotFound(format!("job {id}"))),
        Some(s) => Err(AppError::Conflict(format!(
            "job {id} is {s} and not held by this worker"
        ))),
    }
}

fn require_worker(worker_id: &str) -> Result<(), AppError> {
    if worker_id.is_empty() || worker_id.len() > 128 {
        return Err(AppError::BadRequest(
            "worker_id must be 1 to 128 characters".into(),
        ));
    }
    Ok(())
}

pub async fn get_job(db: &PgPool, id: Uuid) -> Result<Job, AppError> {
    sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("job {id}")))
}

pub async fn list_jobs(db: &PgPool, project_id: Uuid, limit: i64) -> Result<Vec<Job>, AppError> {
    Ok(sqlx::query_as(
        "SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at DESC, id LIMIT $2",
    )
    .bind(project_id)
    .bind(limit)
    .fetch_all(db)
    .await?)
}

/// Background loop for the server binary: reap stale jobs forever.
pub async fn run_reaper(db: PgPool) {
    let mut tick = tokio::time::interval(REAP_INTERVAL);
    loop {
        tick.tick().await;
        match reap_stale(&db, HEARTBEAT_TIMEOUT).await {
            Ok(jobs) if !jobs.is_empty() => {
                tracing::warn!(count = jobs.len(), "reaped jobs with no heartbeat");
            }
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "reaping stale jobs failed"),
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{project_id}/jobs",
            post(enqueue_handler).get(list_handler),
        )
        .route(
            "/api/projects/{project_id}/jobs/events",
            get(events_handler),
        )
        .route("/api/jobs/claim", post(claim_handler))
        .route("/api/jobs/{id}", get(get_handler))
        .route("/api/jobs/{id}/heartbeat", post(heartbeat_handler))
        .route("/api/jobs/{id}/progress", post(progress_handler))
        .route("/api/jobs/{id}/complete", post(complete_handler))
        .route("/api/jobs/{id}/fail", post(fail_handler))
}

#[derive(Deserialize)]
struct EnqueueBody {
    kind: String,
    #[serde(default = "empty_object")]
    payload: Value,
    max_attempts: Option<i32>,
}

fn empty_object() -> Value {
    json!({})
}

async fn enqueue_handler(
    State(s): State<AppState>,
    Path(project_id): Path<Uuid>,
    Json(b): Json<EnqueueBody>,
) -> Result<(StatusCode, Json<Job>), AppError> {
    let max = b.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS);
    let job = enqueue(&s.db, project_id, &b.kind, b.payload, max).await?;
    Ok((StatusCode::CREATED, Json(job)))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

async fn list_handler(
    State(s): State<AppState>,
    Path(project_id): Path<Uuid>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Job>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    Ok(Json(list_jobs(&s.db, project_id, limit).await?))
}

async fn get_handler(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Job>, AppError> {
    Ok(Json(get_job(&s.db, id).await?))
}

#[derive(Deserialize)]
struct ClaimBody {
    worker_id: String,
    #[serde(default)]
    kinds: Vec<String>,
}

/// 200 with the job, or 204 when the queue has nothing runnable.
async fn claim_handler(
    State(s): State<AppState>,
    Json(b): Json<ClaimBody>,
) -> Result<Response, AppError> {
    Ok(match claim(&s.db, &b.worker_id, &b.kinds).await? {
        Some(job) => Json(job).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

#[derive(Deserialize)]
struct WorkerBody {
    worker_id: String,
}

async fn heartbeat_handler(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<WorkerBody>,
) -> Result<Json<Job>, AppError> {
    Ok(Json(heartbeat(&s.db, id, &b.worker_id).await?))
}

#[derive(Deserialize)]
struct ProgressBody {
    worker_id: String,
    message: String,
    #[serde(default = "empty_object")]
    data: Value,
}

async fn progress_handler(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<ProgressBody>,
) -> Result<Json<Job>, AppError> {
    Ok(Json(
        progress(&s.db, id, &b.worker_id, &b.message, b.data).await?,
    ))
}

#[derive(Deserialize)]
struct CompleteBody {
    worker_id: String,
    #[serde(default = "empty_object")]
    result: Value,
}

async fn complete_handler(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<CompleteBody>,
) -> Result<Json<Job>, AppError> {
    Ok(Json(complete(&s.db, id, &b.worker_id, b.result).await?))
}

#[derive(Deserialize)]
struct FailBody {
    worker_id: String,
    error: String,
}

async fn fail_handler(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<FailBody>,
) -> Result<Json<Job>, AppError> {
    Ok(Json(fail(&s.db, id, &b.worker_id, &b.error).await?))
}

#[derive(Deserialize)]
struct EventsQuery {
    /// Replay events with an id greater than this. Overridden by the
    /// `Last-Event-ID` header, which browsers send when they reconnect.
    after: Option<i64>,
}

/// `GET /api/projects/{id}/jobs/events`: server-sent events for every job in
/// the project. Each event carries the job event row as JSON, its `id` is the
/// row id, and its name is the event kind (`queued`, `started`, `progress`,
/// `retrying`, `succeeded`, `failed`). Without `after` or `Last-Event-ID` the
/// stream starts from now; `?after=0` replays the whole history.
async fn events_handler(
    State(s): State<AppState>,
    Path(project_id): Path<Uuid>,
    Query(q): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let from_header = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());
    let start = match from_header.or(q.after) {
        Some(id) => id,
        None => {
            sqlx::query_scalar("SELECT COALESCE(max(id), 0) FROM job_events WHERE project_id = $1")
                .bind(project_id)
                .fetch_one(&s.db)
                .await?
        }
    };
    let state = StreamState {
        db: s.db,
        project_id,
        last_id: start,
        buffer: VecDeque::new(),
    };
    let stream = futures_util::stream::unfold(state, next_event);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

struct StreamState {
    db: PgPool,
    project_id: Uuid,
    last_id: i64,
    buffer: VecDeque<JobEvent>,
}

async fn next_event(mut st: StreamState) -> Option<(Result<Event, Infallible>, StreamState)> {
    loop {
        if let Some(ev) = st.buffer.pop_front() {
            st.last_id = ev.id;
            let out = Event::default()
                .id(ev.id.to_string())
                .event(ev.event.clone())
                .json_data(&ev);
            match out {
                Ok(e) => return Some((Ok(e), st)),
                Err(e) => {
                    tracing::error!(error = %e, "could not encode job event");
                    continue;
                }
            }
        }
        let rows: Result<Vec<JobEvent>, _> = sqlx::query_as(
            "SELECT * FROM job_events WHERE project_id = $1 AND id > $2 ORDER BY id LIMIT $3",
        )
        .bind(st.project_id)
        .bind(st.last_id)
        .bind(STREAM_BATCH)
        .fetch_all(&st.db)
        .await;
        match rows {
            Ok(rows) if !rows.is_empty() => st.buffer.extend(rows),
            Ok(_) => tokio::time::sleep(STREAM_POLL).await,
            Err(e) => {
                tracing::error!(error = %e, "reading job events failed");
                tokio::time::sleep(STREAM_POLL).await;
            }
        }
    }
}
