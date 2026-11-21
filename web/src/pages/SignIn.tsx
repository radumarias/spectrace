/** Shown when there is no session. The login endpoint is a redirect, so this is a plain link. */
export function SignIn() {
  return (
    <main className="signin" tabIndex={-1}>
      <div className="signin-card">
        <h1>spectrace</h1>
        <p>Sign in to review pull requests against your specs.</p>
        <a className="btn pri" href="/api/auth/github/login">
          Sign in with GitHub
        </a>
      </div>
    </main>
  );
}
