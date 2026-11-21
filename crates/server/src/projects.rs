//! Projects: a name, some context for the agents, and the repositories the
//! project covers. Every route needs a signed-in user and only ever sees that
//! user's own projects; someone else's project answers 404, the same as one
//! that does not exist, so ids cannot be probed.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{auth::User, AppError, AppState};

const MAX_NAME: usize = 120;
const MAX_CONTEXT: usize = 20_000;
const MAX_REPOS: usize = 50;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list).post(create))
        .route("/api/projects/{id}", get(read).patch(update).delete(remove))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct ProjectRow {
    id: Uuid,
    name: String,
    context: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Repo {
    pub id: Uuid,
    #[serde(skip)]
    project_id: Uuid,
    pub github_repo_id: Option<i64>,
    pub full_name: String,
    pub default_branch: String,
    pub index_state: String,
}

#[derive(Debug, Serialize)]
pub struct Project {
    #[serde(flatten)]
    row: ProjectRow,
    repos: Vec<Repo>,
}

/// A repository as the client sends it.
#[derive(Debug, Deserialize)]
pub struct RepoInput {
    pub github_repo_id: Option<i64>,
    pub full_name: String,
    pub default_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProject {
    name: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    repos: Vec<RepoInput>,
}

/// Omitted fields stay as they are. `repos`, when present, replaces the whole
/// list (repos already attached keep their id and index state).
#[derive(Debug, Deserialize)]
pub struct UpdateProject {
    name: Option<String>,
    context: Option<String>,
    repos: Option<Vec<RepoInput>>,
}

fn clean_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("project name is required".into()));
    }
    if name.chars().count() > MAX_NAME {
        return Err(AppError::BadRequest(format!(
            "project name is longer than {MAX_NAME} characters"
        )));
    }
    Ok(name.to_string())
}

fn check_context(context: &str) -> Result<(), AppError> {
    if context.len() > MAX_CONTEXT {
        return Err(AppError::BadRequest(format!(
            "project context is longer than {MAX_CONTEXT} bytes"
        )));
    }
    Ok(())
}

/// Validate and normalise repos: `owner/name`, no duplicates (case-insensitive).
fn clean_repos(repos: Vec<RepoInput>) -> Result<Vec<RepoInput>, AppError> {
    if repos.len() > MAX_REPOS {
        return Err(AppError::BadRequest(format!(
            "a project can have at most {MAX_REPOS} repositories"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(repos.len());
    for mut r in repos {
        r.full_name = r.full_name.trim().to_string();
        let ok = match r.full_name.split_once('/') {
            Some((owner, name)) => {
                let part = |s: &str| {
                    !s.is_empty()
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                };
                part(owner) && part(name)
            }
            None => false,
        };
        if !ok {
            return Err(AppError::BadRequest(format!(
                "repository must look like owner/name, got {:?}",
                r.full_name
            )));
        }
        if !seen.insert(r.full_name.to_lowercase()) {
            return Err(AppError::BadRequest(format!(
                "repository {} is listed twice",
                r.full_name
            )));
        }
        if let Some(b) = &r.default_branch {
            if b.trim().is_empty() {
                return Err(AppError::BadRequest("default_branch is empty".into()));
            }
        }
        out.push(r);
    }
    Ok(out)
}

fn not_found(id: Uuid) -> AppError {
    AppError::NotFound(format!("project {id}"))
}

async fn insert_repos(
    tx: &mut sqlx::PgConnection,
    project_id: Uuid,
    repos: &[RepoInput],
) -> Result<(), AppError> {
    for r in repos {
        sqlx::query(
            "INSERT INTO project_repos (project_id, github_repo_id, full_name, default_branch)
             VALUES ($1, $2, $3, COALESCE($4, 'main'))",
        )
        .bind(project_id)
        .bind(r.github_repo_id)
        .bind(&r.full_name)
        .bind(r.default_branch.as_deref().map(str::trim))
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

/// Load one project owned by `owner`, with its repos.
pub async fn load(state: &AppState, owner: Uuid, id: Uuid) -> Result<Project, AppError> {
    let row = sqlx::query_as::<_, ProjectRow>(
        "SELECT id, name, context, created_at, updated_at
         FROM projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| not_found(id))?;
    let repos = sqlx::query_as::<_, Repo>(
        "SELECT id, project_id, github_repo_id, full_name, default_branch, index_state
         FROM project_repos WHERE project_id = $1 ORDER BY created_at, full_name",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Project { row, repos })
}

/// For other modules (jobs, runners): `Ok` only if `user` owns the project.
pub async fn require_owner(state: &AppState, user: &User, id: Uuid) -> Result<(), AppError> {
    let found: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM projects WHERE id = $1 AND owner_id = $2")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?;
    found.map(|_| ()).ok_or_else(|| not_found(id))
}

async fn list(State(state): State<AppState>, user: User) -> Result<Json<Vec<Project>>, AppError> {
    let rows = sqlx::query_as::<_, ProjectRow>(
        "SELECT id, name, context, created_at, updated_at
         FROM projects WHERE owner_id = $1 ORDER BY created_at, id",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let mut repos = sqlx::query_as::<_, Repo>(
        "SELECT r.id, r.project_id, r.github_repo_id, r.full_name, r.default_branch, r.index_state
         FROM project_repos r JOIN projects p ON p.id = r.project_id
         WHERE p.owner_id = $1 ORDER BY r.created_at, r.full_name",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let projects = rows
        .into_iter()
        .map(|row| {
            let (mine, rest): (Vec<_>, Vec<_>) =
                repos.drain(..).partition(|r| r.project_id == row.id);
            repos = rest;
            Project { row, repos: mine }
        })
        .collect();
    Ok(Json(projects))
}

async fn create(
    State(state): State<AppState>,
    user: User,
    Json(body): Json<CreateProject>,
) -> Result<(StatusCode, Json<Project>), AppError> {
    let name = clean_name(&body.name)?;
    check_context(&body.context)?;
    let repos = clean_repos(body.repos)?;

    let mut tx = state.db.begin().await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO projects (owner_id, name, context) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user.id)
    .bind(&name)
    .bind(&body.context)
    .fetch_one(&mut *tx)
    .await?;
    insert_repos(&mut tx, id, &repos).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(load(&state, user.id, id).await?)))
}

async fn read(
    State(state): State<AppState>,
    user: User,
    Path(id): Path<Uuid>,
) -> Result<Json<Project>, AppError> {
    Ok(Json(load(&state, user.id, id).await?))
}

async fn update(
    State(state): State<AppState>,
    user: User,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateProject>,
) -> Result<Json<Project>, AppError> {
    let name = body.name.as_deref().map(clean_name).transpose()?;
    if let Some(c) = &body.context {
        check_context(c)?;
    }
    let repos = body.repos.map(clean_repos).transpose()?;

    let mut tx = state.db.begin().await?;
    // Lock the row; this is also the owner check.
    let locked: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM projects WHERE id = $1 AND owner_id = $2 FOR UPDATE")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
    locked.ok_or_else(|| not_found(id))?;

    sqlx::query(
        "UPDATE projects
         SET name = COALESCE($2, name), context = COALESCE($3, context), updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(body.context)
    .execute(&mut *tx)
    .await?;

    if let Some(repos) = repos {
        let keep: Vec<String> = repos.iter().map(|r| r.full_name.to_lowercase()).collect();
        sqlx::query(
            "DELETE FROM project_repos
             WHERE project_id = $1 AND NOT (lower(full_name) = ANY($2))",
        )
        .bind(id)
        .bind(&keep)
        .execute(&mut *tx)
        .await?;
        for r in &repos {
            sqlx::query(
                "INSERT INTO project_repos (project_id, github_repo_id, full_name, default_branch)
                 VALUES ($1, $2, $3, COALESCE($4, 'main'))
                 ON CONFLICT (project_id, full_name) DO UPDATE
                   SET github_repo_id = COALESCE(EXCLUDED.github_repo_id, project_repos.github_repo_id),
                       default_branch = COALESCE($4, project_repos.default_branch)",
            )
            .bind(id)
            .bind(r.github_repo_id)
            .bind(&r.full_name)
            .bind(r.default_branch.as_deref().map(str::trim))
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(Json(load(&state, user.id, id).await?))
}

async fn remove(
    State(state): State<AppState>,
    user: User,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let res = sqlx::query("DELETE FROM projects WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(not_found(id));
    }
    Ok(StatusCode::NO_CONTENT)
}
