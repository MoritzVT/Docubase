import { onAuthStateChanged, type User } from "firebase/auth";
import { useEffect, useState } from "react";
import { LoadingScreen } from "./components/SharedUi";
import { AuthScreen, ConfigurationScreen } from "./features/auth/AuthScreens";
import { Workspace } from "./features/projects/Workspace";
import { firebaseConfigurationError, requireAuth } from "./lib/firebase";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

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

  if (firebaseConfigurationError) {
    return <ConfigurationScreen message={firebaseConfigurationError} />;
  }
  if (authLoading) return <LoadingScreen label="Opening Docubase…" />;
  if (!user) return <AuthScreen />;
  return <Workspace user={user} />;
}
