import type { AiUsageSummary, AssistantConfig } from "@template/contracts";
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Skeleton,
  toast,
} from "@template/ui";
import { useEffect, useState, type FormEvent } from "react";
import { FormError } from "../auth/layout";
import { errorMessage, useApi, useCan, useSubmit } from "../context";

/**
 * The organization's AI: this month's spend, today's requests, and (owners) the default model,
 * monthly budget and daily cap. A turn over the budget gets a calm message, not a failure.
 */
export function AiSettingsCard() {
  const api = useApi();
  const canSee = useCan("ai.usage");
  const owner = useCan("ai.manage");
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState("");
  const [daily, setDaily] = useState("");

  useEffect(() => {
    if (!canSee) return;
    Promise.all([api.assistant.usage(), api.assistant.config()])
      .then(([loaded, assistant]) => {
        setUsage(loaded);
        setConfig(assistant);
        setModel(loaded.settings.defaultModel);
        setBudget(String(loaded.settings.monthlyBudgetUsd));
        setDaily(String(loaded.settings.dailyRequests));
      })
      .catch((failure: unknown) => setError(errorMessage(failure)));
  }, [api, canSee]);

  const save = useSubmit(async () => {
    const saved = await api.assistant.saveSettings({
      defaultModel: model,
      monthlyBudgetUsd: Number(budget),
      dailyRequests: Number(daily),
    });
    setUsage(saved);
    toast("AI settings saved", { tone: "success" });
  });

  if (!canSee) return null;
  return (
    <Card>
      <CardHeader
        title="AI"
        description="The Assistant and the Automation Builder share one monthly budget."
      />
      <CardBody>
        {error ? (
          <Alert tone="warning" title="AI usage couldn't load">
            {error}
          </Alert>
        ) : !usage || !config ? (
          <Skeleton className="h-24" />
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void save.run();
            }}
          >
            <p className="text-sm">
              ${usage.monthUsd.toFixed(2)} of ${usage.settings.monthlyBudgetUsd.toFixed(2)} used
              this month · {usage.todayRequests} of {usage.settings.dailyRequests} requests today
            </p>
            {owner ? (
              <>
                <FormError message={save.error} />
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Default model" error={save.fields.defaultModel}>
                    <Select
                      value={model}
                      onValueChange={setModel}
                      options={config.models.map((m) => ({ value: m.id, label: m.label }))}
                    />
                  </Field>
                  <Field
                    label="Monthly budget (US$)"
                    hint="Spending stops for the month once it's reached."
                    error={save.fields.monthlyBudgetUsd}
                  >
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={budget}
                      onChange={(e) => setBudget(e.target.value)}
                    />
                  </Field>
                  <Field label="Requests a day" error={save.fields.dailyRequests}>
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={daily}
                      onChange={(e) => setDaily(e.target.value)}
                    />
                  </Field>
                </div>
                <Button type="submit" loading={save.pending} className="justify-self-start">
                  Save AI settings
                </Button>
              </>
            ) : null}
          </form>
        )}
      </CardBody>
    </Card>
  );
}
