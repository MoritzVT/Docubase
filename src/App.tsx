import { onAuthStateChanged, type User } from "firebase/auth";
import { useEffect, useState } from "react";
import splashLogo from "./assets/ratfish-logo.svg";
import { LoadingScreen } from "./components/SharedUi";
import { AuthScreen, ConfigurationScreen } from "./features/auth/AuthScreens";
import { Workspace } from "./features/projects/Workspace";
import { firebaseConfigurationError, requireAuth } from "./lib/firebase";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => setShowSplash(false), 3200);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (firebaseConfigurationError) {
      setAuthLoading(false);
      return;
    }
    return onAuthStateChanged(requireAuth(), (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
    });
  }, []);

  let content;
  if (firebaseConfigurationError) {
    content = <ConfigurationScreen message={firebaseConfigurationError} />;
  } else if (authLoading) {
    content = <LoadingScreen label="Opening Docubase…" />;
  } else if (!user) {
    content = <AuthScreen />;
  } else {
    content = <Workspace user={user} />;
  }

  return (
    <>
      {content}
      {showSplash && (
        <div aria-hidden="true" className="splash-screen">
          <img alt="" className="splash-logo" src={splashLogo} />
        </div>
      )}
    </>
  );
}
