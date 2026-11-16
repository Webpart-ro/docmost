import { useState } from "react";
import {
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import {
  useApiTokensQuery,
  useCreateApiTokenMutation,
  useRevokeApiTokenMutation,
} from "@/features/api-token/queries/api-token-query";

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiry" },
];

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export default function ApiTokens() {
  const { t } = useTranslation();
  const { data: tokens, isLoading } = useApiTokensQuery();
  const createMutation = useCreateApiTokenMutation();
  const revokeMutation = useRevokeApiTokenMutation();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>("90");
  const [newToken, setNewToken] = useState<string | null>(null);

  const mcpUrl = `${window.location.origin}/mcp`;
  const mcpCommand = newToken
    ? `claude mcp add --transport http webpart-docs ${mcpUrl} --header "Authorization: Bearer ${newToken}"`
    : "";

  const handleCreate = async () => {
    const expiresAt =
      expiry === "never"
        ? undefined
        : new Date(Date.now() + Number(expiry) * 86400000).toISOString();
    const created = await createMutation.mutateAsync({
      name: name.trim(),
      expiresAt,
    });
    setCreateOpen(false);
    setName("");
    setNewToken(created.token ?? null);
  };

  const confirmRevoke = (id: string, tokenName: string) =>
    modals.openConfirmModal({
      title: t("Revoke token"),
      children: (
        <Text size="sm">
          {t("Anything using “{{name}}” will stop working immediately.", {
            name: tokenName,
          })}
        </Text>
      ),
      labels: { confirm: t("Revoke"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => revokeMutation.mutate(id),
    });

  return (
    <>
      <DocumentTitle title={t("API tokens")} />
      <SettingsTitle title={t("API tokens")} />

      <Group justify="space-between" mb="md" wrap="nowrap" align="flex-start">
        <Text size="sm" c="dimmed">
          {t(
            "Tokens act as you, with your permissions. Use them for the REST API (/api) or the MCP endpoint ({{url}}).",
            { url: mcpUrl },
          )}
        </Text>
        <Button onClick={() => setCreateOpen(true)} style={{ flexShrink: 0 }}>
          {t("Create token")}
        </Button>
      </Group>

      <Table.ScrollContainer minWidth={500}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Name")}</Table.Th>
              <Table.Th>{t("Created")}</Table.Th>
              <Table.Th>{t("Last used")}</Table.Th>
              <Table.Th>{t("Expires")}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tokens?.map((token) => (
              <Table.Tr key={token.id}>
                <Table.Td>{token.name}</Table.Td>
                <Table.Td>{formatDate(token.createdAt)}</Table.Td>
                <Table.Td>{formatDate(token.lastUsedAt)}</Table.Td>
                <Table.Td>
                  {token.expiresAt ? formatDate(token.expiresAt) : t("Never")}
                </Table.Td>
                <Table.Td align="right">
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    onClick={() => confirmRevoke(token.id, token.name)}
                  >
                    {t("Revoke")}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
            {!isLoading && tokens?.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text size="sm" c="dimmed">
                    {t("No tokens yet.")}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("Create token")}
      >
        <Stack>
          <TextInput
            label={t("Name")}
            placeholder={t("e.g. Claude Code on my laptop")}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={100}
            data-autofocus
          />
          <Select
            label={t("Expires")}
            data={EXPIRY_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            value={expiry}
            onChange={(v) => setExpiry(v ?? "90")}
            allowDeselect={false}
          />
          <Group justify="flex-end">
            <Button
              onClick={handleCreate}
              loading={createMutation.isPending}
              disabled={!name.trim()}
            >
              {t("Create")}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={!!newToken}
        onClose={() => setNewToken(null)}
        title={t("Token created")}
        size="lg"
      >
        <Stack>
          <Alert color="yellow">
            {t("Copy it now. It won't be shown again.")}
          </Alert>
          <Code block style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
            {newToken}
          </Code>
          <CopyButton value={newToken ?? ""}>
            {({ copied, copy }) => (
              <Button variant="light" onClick={copy}>
                {copied ? t("Copied") : t("Copy token")}
              </Button>
            )}
          </CopyButton>
          <Text size="sm" fw={500}>
            {t("Add to Claude Code")}
          </Text>
          <Code block style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
            {mcpCommand}
          </Code>
          <CopyButton value={mcpCommand}>
            {({ copied, copy }) => (
              <Button variant="default" onClick={copy}>
                {copied ? t("Copied") : t("Copy command")}
              </Button>
            )}
          </CopyButton>
        </Stack>
      </Modal>
    </>
  );
}
