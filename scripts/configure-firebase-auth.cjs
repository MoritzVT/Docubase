const {
  getConfig,
  updateConfig,
} = require("../node_modules/firebase-tools/lib/gcp/identityPlatform.js");
const {
  getGlobalDefaultAccount,
} = require("../node_modules/firebase-tools/lib/auth.js");
const {
  requireAuth,
} = require("../node_modules/firebase-tools/lib/requireAuth.js");
const {
  Client,
} = require("../node_modules/firebase-tools/lib/apiv2.js");
const {
  identityOrigin,
} = require("../node_modules/firebase-tools/lib/api.js");

const projectId = process.argv[2];
if (!projectId) {
  throw new Error("Usage: node configure-firebase-auth.cjs <project-id>");
}

async function configure() {
  const account = getGlobalDefaultAccount();
  if (!account) {
    throw new Error("Run `firebase login` before configuring Authentication.");
  }
  await requireAuth({ project: projectId, ...account });

  let current;
  try {
    current = await getConfig(projectId);
  } catch (error) {
    if (!String(error.message).includes("CONFIGURATION_NOT_FOUND")) {
      throw error;
    }
    const adminApiClient = new Client({
      urlPrefix: identityOrigin(),
      apiVersion: "v2",
    });
    await adminApiClient.post(
      `projects/${projectId}/identityPlatform:initializeAuth`,
      {},
    );
    current = await getConfig(projectId);
  }
  if (current?.signIn?.email?.enabled && current.signIn.email.passwordRequired) {
    console.log("Firebase Email/Password authentication is already enabled.");
    return;
  }

  await updateConfig(
    projectId,
    {
      signIn: {
        email: {
          enabled: true,
          passwordRequired: true,
        },
      },
    },
    "signIn.email",
  );
  console.log("Firebase Email/Password authentication is enabled.");
}

configure().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
