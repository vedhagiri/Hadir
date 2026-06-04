// Settings → Request reasons. Admin-only CRUD on the reason category
// list employees see when filing a new request. Two segmented tables
// (Exception / Leave) so the operator can extend each list separately.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { SettingsTabs } from "../settings/SettingsTabs";
import { Icon } from "../shell/Icon";
import {
  useCreateReasonCategory,
  useDeleteReasonCategory,
  usePatchReasonCategory,
  useReasonCategoriesAll,
} from "./hooks";
import type { ReasonCategory, RequestType } from "./types";

export function ReasonCategoriesPage() {
  const { t } = useTranslation();
  const all = useReasonCategoriesAll(true);
  const [error, setError] = useState<string | null>(null);

  const exceptionRows = (all.data ?? []).filter(
    (c) => c.request_type === "exception",
  );
  const leaveRows = (all.data ?? []).filter(
    (c) => c.request_type === "leave",
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          {t("reasonCategories.title")}
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("reasonCategories.subtitle")}
        </p>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--border)",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      {all.isLoading ? (
        <p>{t("reasonCategories.loading")}</p>
      ) : all.error ? (
        <p style={{ color: "var(--danger-text)" }}>
          {t("reasonCategories.loadFailed")}
        </p>
      ) : (
        <>
          <CategoryTable
            title={t("reasonCategories.exceptionTitle")}
            requestType="exception"
            rows={exceptionRows}
            onError={setError}
          />
          <CategoryTable
            title={t("reasonCategories.leaveTitle")}
            requestType="leave"
            rows={leaveRows}
            onError={setError}
          />
        </>
      )}
    </div>
  );
}

function CategoryTable({
  title,
  requestType,
  rows,
  onError,
}: {
  title: string;
  requestType: RequestType;
  rows: ReasonCategory[];
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateReasonCategory();
  const patch = usePatchReasonCategory();
  const del = useDeleteReasonCategory();

  const [showCreate, setShowCreate] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    try {
      await create.mutateAsync({
        request_type: requestType,
        code: code.trim(),
        name: name.trim(),
      });
      setCode("");
      setName("");
      setShowCreate(false);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : t("reasonCategories.saveFailed"));
    }
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>{title}</h2>
        <button
          className="btn btn-sm"
          onClick={() => setShowCreate((s) => !s)}
        >
          <Icon name="plus" size={12} />{" "}
          {showCreate ? t("reasonCategories.closeBtn") : t("reasonCategories.addBtn")}
        </button>
      </div>
      {showCreate && (
        <form
          onSubmit={submit}
          style={{
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 10,
            display: "grid",
            gridTemplateColumns: "1fr 1.4fr auto",
            gap: 8,
            alignItems: "end",
          }}
        >
          <Field label={t("reasonCategories.fieldCode")}>
            <input
              className="input mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("reasonCategories.codePlaceholder")}
            />
          </Field>
          <Field label={t("reasonCategories.fieldName")}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("reasonCategories.namePlaceholder")}
            />
          </Field>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={create.isPending}
          >
            {create.isPending ? t("reasonCategories.saving") : t("reasonCategories.save")}
          </button>
        </form>
      )}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>{t("reasonCategories.colOrder")}</th>
              <th>{t("reasonCategories.colCode")}</th>
              <th>{t("reasonCategories.colName")}</th>
              <th>{t("reasonCategories.colStatus")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-sm text-dim">
                  {t("reasonCategories.empty")}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono text-xs">{r.display_order}</td>
                  <td className="mono">{r.code}</td>
                  <td>{r.name}</td>
                  <td>
                    <span
                      className={`pill ${r.active ? "pill-success" : "pill-neutral"}`}
                    >
                      {r.active ? t("reasonCategories.statusActive") : t("reasonCategories.statusInactive")}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        patch.mutate({
                          id: r.id,
                          input: { active: !r.active },
                        })
                      }
                      disabled={patch.isPending}
                    >
                      {r.active ? t("reasonCategories.hide") : t("reasonCategories.activate")}
                    </button>{" "}
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        if (
                          window.confirm(
                            t("reasonCategories.confirmDelete", { code: r.code }),
                          )
                        ) {
                          del.mutate(r.id);
                        }
                      }}
                      style={{ color: "var(--danger-text)" }}
                      disabled={del.isPending}
                    >
                      {t("reasonCategories.delete")}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "var(--text-secondary)",
      }}
    >
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
