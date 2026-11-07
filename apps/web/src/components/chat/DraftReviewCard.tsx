import { useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, FilePenLineIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export interface ReviewDraftText {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DraftReviewPresentation {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly fields: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly required?: boolean | undefined;
  }>;
}

export function DraftReviewCard({
  title,
  presentation,
  original,
  value,
  status,
  onChange,
  onConfirm,
  onDismiss,
  onReopen,
  unavailable = false,
  revised = false,
  readOnly = false,
}: {
  readonly title: string;
  readonly presentation: DraftReviewPresentation;
  readonly original: ReviewDraftText;
  readonly value: ReviewDraftText;
  readonly status: "pending" | "confirmed" | "dismissed";
  readonly onChange: (value: ReviewDraftText) => void;
  readonly onConfirm: () => Promise<void>;
  readonly onDismiss: () => void | Promise<void>;
  readonly onReopen: () => void | Promise<void>;
  readonly unavailable?: boolean;
  readonly revised?: boolean;
  readonly readOnly?: boolean;
}) {
  const id = useId();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = status === "pending";
  const changed =
    original.body !== value.body ||
    presentation.fields.some(
      (field) => (original.fields[field.id] ?? "") !== (value.fields[field.id] ?? ""),
    );
  const valid =
    value.body.trim().length > 0 &&
    presentation.fields.every(
      (field) => !field.required || (value.fields[field.id] ?? "").trim().length > 0,
    );
  const act = async (action: () => void | Promise<void>) => {
    if (busy.current || unavailable) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("No se pudo entregar el draft. Tus cambios siguen aquí. Inténtalo de nuevo.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <section
      aria-label={`Draft: ${title}`}
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-mesura-owns-keys
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3 sm:px-5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
          {presentation.icon ?? <FilePenLineIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold wrap-anywhere">{title}</h2>
            <span className="rounded border border-border px-1.5 py-0.5 text-caption font-medium text-muted-foreground">
              Draft
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium">{presentation.label}</span> ·{" "}
            {pending
              ? "Edita el texto antes de continuar."
              : status === "confirmed"
                ? "Texto confirmado para el agente."
                : "Draft descartado."}
          </p>
        </div>
        {pending ? (
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={`Descartar ${title}`}
            disabled={saving || unavailable}
            onClick={() => void act(onDismiss)}
          >
            <XIcon />
          </Button>
        ) : (
          <CheckIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        )}
      </header>

      {status !== "dismissed" ? (
        <div className="space-y-3 px-4 py-4 sm:px-5">
          {presentation.fields.length > 0 ? (
            <div className="space-y-2.5">
              {presentation.fields.map((field) => (
                <label
                  key={field.id}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs text-muted-foreground wrap-anywhere"
                >
                  {field.label}
                  <Input
                    aria-label={field.label}
                    required={field.required}
                    value={value.fields[field.id] ?? ""}
                    maxLength={4000}
                    disabled={!pending || saving || unavailable}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        fields: { ...value.fields, [field.id]: event.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ) : null}
          <label htmlFor={id} className="sr-only">
            Texto del draft
          </label>
          {pending ? (
            <Textarea
              id={id}
              value={value.body}
              maxLength={100000}
              disabled={saving || unavailable}
              onChange={(event) => onChange({ ...value, body: event.target.value })}
              className="[&_textarea]:min-h-44 [&_textarea]:max-h-[45dvh] [&_textarea]:resize-y"
            />
          ) : (
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-sm leading-7">
              {value.body}
            </p>
          )}
          {pending && changed ? (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={saving || unavailable}
              onClick={() => {
                onChange(original);
                setError(null);
              }}
            >
              <RotateCcwIcon /> Recuperar original
            </Button>
          ) : null}
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground" aria-live="polite">
          {unavailable ? (
            <p>Conecta con permiso de edición para continuar.</p>
          ) : error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : pending ? (
            <p>{changed ? "Con tus cambios" : "Texto original"} · No se publica ni se envía</p>
          ) : (
            <p>
              {status === "confirmed"
                ? "El agente recibe esta versión exacta."
                : "El agente no recibe el texto."}
            </p>
          )}
        </div>
        {pending ? (
          <Button disabled={!valid || saving || unavailable} onClick={() => void act(onConfirm)}>
            <CheckIcon /> {saving ? "Entregando…" : error ? "Reintentar" : "Usar este texto"}
          </Button>
        ) : !readOnly ? (
          <Button
            variant="outline"
            size="sm"
            disabled={saving || unavailable || revised}
            onClick={() => void act(onReopen)}
          >
            <RotateCcwIcon /> {revised ? "Nueva revisión creada" : "Volver a editar"}
          </Button>
        ) : null}
      </footer>
    </section>
  );
}
