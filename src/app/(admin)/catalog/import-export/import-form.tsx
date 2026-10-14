"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { IMPORT_ISSUE_CODES, MAX_IMPORT_BYTES, type ImportIssueCode } from "@/domain/csv-catalog";
import { useAction } from "@/hooks/use-action";
import {
  commitCatalogImportAction,
  previewCatalogImportAction,
} from "@/server/actions/catalog-import";
import type { ImportPreview } from "@/server/services/catalog-import";

const isCode = (code: string): code is ImportIssueCode =>
  (IMPORT_ISSUE_CODES as readonly string[]).includes(code);

type Stage = "choose" | "preview" | "done";

export function ImportForm() {
  const t = useTranslations("importExport");
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const previewAction = useAction(previewCatalogImportAction);
  const commitAction = useAction(commitCatalogImportAction);

  const reset = () => {
    setCsv(null);
    setFileName("");
    setPreview(null);
    setLocalError(null);
    setStage("choose");
    previewAction.reset();
    commitAction.reset();
    if (fileRef.current) fileRef.current.value = "";
  };

  async function onFile(file: File | undefined) {
    setCsv(null);
    setPreview(null);
    setLocalError(null);
    previewAction.reset();
    commitAction.reset();
    setStage("choose");
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setLocalError(t("tooLargeClient"));
      return;
    }
    try {
      setCsv(await file.text());
    } catch {
      setLocalError(t("readFailed"));
    }
  }

  const checkFile = () => {
    if (!csv || previewAction.pending) return;
    previewAction.run(
      { csv },
      {
        onSuccess: (result) => {
          setPreview(result);
          setStage("preview");
        },
      },
    );
  };

  const importFile = () => {
    if (!csv || commitAction.pending) return;
    commitAction.run(
      { csv },
      {
        onSuccess: (outcome) => {
          setPreview(outcome.preview);
          if (outcome.committed) {
            toast.success(t("committed"));
            setStage("done");
          } else {
            setStage("preview");
          }
        },
      },
    );
  };

  const hasIssues = (preview?.issueCount ?? 0) > 0;
  const error = previewAction.errorMessage ?? commitAction.errorMessage ?? localError;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("import.heading")}</CardTitle>
        <CardDescription>{t("import.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t("help.heading")}</summary>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
            {(
              ["matching", "blank", "grouping", "options", "barcodes", "cost", "category"] as const
            ).map((key) => (
              <li key={key}>{t(`help.${key}`)}</li>
            ))}
          </ul>
        </details>

        {stage === "done" ? null : (
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>{t("import.file")}</Label>
            <Input
              id={inputId}
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              aria-describedby={`${inputId}-hint`}
              onChange={(event) => void onFile(event.target.files?.[0])}
              className="h-auto py-2"
            />
            <p id={`${inputId}-hint`} className="text-sm text-muted-foreground">
              {t("import.fileHint")}
            </p>
          </div>
        )}

        <div aria-live="polite" className="space-y-4">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {previewAction.pending || commitAction.pending ? (
            <p role="status" className="text-sm text-muted-foreground">
              {commitAction.pending ? t("import.committing") : t("import.previewing")}
            </p>
          ) : null}

          {preview && stage !== "choose" ? (
            <PreviewResult preview={preview} done={stage === "done"} />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {stage === "choose" ? (
            <Button
              type="button"
              onClick={checkFile}
              disabled={!csv || previewAction.pending}
              aria-busy={previewAction.pending}
            >
              {previewAction.pending ? t("import.previewing") : t("import.preview")}
            </Button>
          ) : null}
          {stage === "preview" && !hasIssues ? (
            <Button
              type="button"
              onClick={importFile}
              disabled={commitAction.pending}
              aria-busy={commitAction.pending}
            >
              {commitAction.pending ? t("import.committing") : t("import.commit")}
            </Button>
          ) : null}
          {stage === "preview" ? (
            <Button type="button" variant="outline" onClick={reset} disabled={commitAction.pending}>
              {t("import.reset")}
            </Button>
          ) : null}
          {stage === "done" ? (
            <Button type="button" variant="outline" onClick={reset}>
              {t("import.another")}
            </Button>
          ) : null}
          {fileName && stage === "choose" ? (
            <span className="self-center text-sm text-muted-foreground">{fileName}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewResult({ preview, done }: { preview: ImportPreview; done: boolean }) {
  const t = useTranslations("importExport");
  const hasIssues = preview.issueCount > 0;

  if (hasIssues) {
    return (
      <section aria-labelledby="import-issues" className="space-y-3">
        <h3 id="import-issues" className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="size-4" aria-hidden />
          {t("issues.heading")}
        </h3>
        <p role="alert" className="text-sm">
          {t("issues.summary", { count: preview.issueCount })} {t("notCommitted")}
        </p>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("preview.line")}</TableHead>
                <TableHead>{t("issues.column")}</TableHead>
                <TableHead>{t("issues.heading")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.issues.map((issue, index) => (
                <TableRow key={`${issue.line}-${issue.column}-${issue.code}-${index}`}>
                  <TableCell className="tabular-nums">
                    {issue.line > 0 ? issue.line : t("issues.fileLevel")}
                  </TableCell>
                  <TableCell>
                    {issue.column ? <code className="text-xs">{issue.column}</code> : "—"}
                  </TableCell>
                  <TableCell>
                    {isCode(issue.code) ? t(`codes.${issue.code}`) : t("codes.invalid")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {preview.issueCount > preview.issues.length ? (
          <p className="text-sm text-muted-foreground">
            {t("issues.more", { count: preview.issueCount - preview.issues.length })}
          </p>
        ) : null}
      </section>
    );
  }

  const stats: [string, number][] = [
    [t("summary.rows"), preview.rowCount],
    [t("summary.create"), preview.create],
    [t("summary.update"), preview.update],
    [t("summary.newVariants"), preview.newVariants],
    [t("summary.updatedVariants"), preview.updatedVariants],
  ];
  return (
    <section aria-labelledby="import-summary" className="space-y-3">
      <h3 id="import-summary" className="flex items-center gap-2 font-medium">
        <CheckCircle2 className="size-4 text-success" aria-hidden />
        {done ? t("committed") : t("ready")}
      </h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {done ? null : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("preview.product")}</TableHead>
                <TableHead>{t("preview.action")}</TableHead>
                <TableHead className="text-end">{t("preview.variants")}</TableHead>
                <TableHead className="text-end">{t("preview.line")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.items.map((item) => (
                <TableRow key={`${item.line}-${item.name}`}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell>
                    <Badge variant={item.action === "create" ? "default" : "secondary"}>
                      {t(`preview.${item.action}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{item.variants}</TableCell>
                  <TableCell className="text-end tabular-nums">{item.line}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!done && preview.create + preview.update > preview.items.length ? (
        <p className="text-sm text-muted-foreground">
          {t("preview.more", { count: preview.create + preview.update - preview.items.length })}
        </p>
      ) : null}
    </section>
  );
}
