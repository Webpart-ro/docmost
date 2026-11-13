import { Alert, Button, Divider, Stack } from "@mantine/core";
import { IconChecklist } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  getBackendUrl,
  getVikunjaAuthName,
  isVikunjaAuthEnabled,
} from "@/lib/config.ts";
import { safeRedirectPath } from "@/lib/app-route.ts";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  state_mismatch: "Your sign-in session expired. Please try again.",
  token_exchange_failed: "Could not complete sign-in. Please try again.",
  userinfo_failed: "Could not read your account. Please try again.",
  no_email: "Your account has no email address.",
  email_not_allowed: "Your email domain is not allowed in this workspace.",
  signup_disabled:
    "No account exists for your email. Ask an admin to invite you.",
  user_disabled: "Your account has been deactivated.",
  disabled: "Single sign-on is not enabled.",
};

type VikunjaLoginProps = {
  showDivider: boolean;
};

// Webpart: full-page navigation to the backend, which runs the OAuth2 + PKCE flow.
export function VikunjaLogin({ showDivider }: VikunjaLoginProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  if (!isVikunjaAuthEnabled()) {
    return null;
  }

  const providerName = getVikunjaAuthName();
  const errorCode = searchParams.get("sso_error");
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? "Sign-in failed. Please try again.")
    : null;

  const loginUrl = new URL(`${getBackendUrl()}/auth/vikunja/login`);
  const redirect = safeRedirectPath(searchParams.get("redirect"));
  if (redirect) {
    loginUrl.searchParams.set("redirect", redirect);
  }

  return (
    <>
      <Stack align="stretch" justify="center" gap="sm">
        {errorMessage && (
          <Alert color="red" variant="light" role="alert">
            {t(errorMessage)}
          </Alert>
        )}
        <Button
          component="a"
          href={loginUrl.toString()}
          leftSection={<IconChecklist size={16} />}
          variant="filled"
          size="md"
          fullWidth
        >
          {t("Sign in with {{provider}}", { provider: providerName })}
        </Button>
      </Stack>

      {showDivider && (
        <Divider my="xs" label={t("OR")} labelPosition="center" />
      )}
    </>
  );
}
