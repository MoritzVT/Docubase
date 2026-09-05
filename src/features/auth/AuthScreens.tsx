import { HardDrive, LoaderCircle } from "lucide-react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { type FormEvent, useState } from "react";
import { Brand, Notice } from "../../components/SharedUi";
import { requireAuth } from "../../lib/firebase";
import { readableError } from "../../lib/presentation";

export function ConfigurationScreen({ message }: { message: string }) {
  return (
    <main className="centered-shell">
      <section className="setup-card">
        <Brand />
        <span className="eyebrow">One-time setup</span>
        <h1>Connect the Firebase web app</h1>
        <p>{message}</p>
        <code>cp .env.example .env.local</code>
        <p className="muted">
          The desktop catalog stays local. Firebase only receives account,
          project, and portable clip metadata.
        </p>
      </section>
    </main>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await createUserWithEmailAndPassword(requireAuth(), email, password);
      } else {
        await signInWithEmailAndPassword(requireAuth(), email, password);
      }
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">Local-first footage intelligence</span>
          <h1>Know what you shot before you start cutting.</h1>
          <p>
            Build a dependable clip catalog from source drives without
            uploading the footage itself.
          </p>
        </div>
        <div className="privacy-note">
          <HardDrive size={18} />
          Source paths and poster frames stay on this Mac.
        </div>
      </section>
      <section className="auth-panel">
        <form className="form-card" onSubmit={submit}>
          <span className="eyebrow">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </span>
          <h2>{mode === "login" ? "Sign in to Docubase" : "Start cataloging"}</h2>
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="editor@studio.com"
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <button className="primary-button" disabled={busy} type="submit">
            {busy && <LoaderCircle className="spin" size={17} />}
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
          <button
            className="text-button"
            onClick={() =>
              setMode((current) =>
                current === "login" ? "register" : "login",
              )
            }
            type="button"
          >
            {mode === "login"
              ? "New to Docubase? Create an account"
              : "Already have an account? Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
