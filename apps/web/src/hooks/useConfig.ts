import { useEffect, useState } from "react";
import type { AppConfig } from "@radio/shared";

import { getConfig } from "../api/client";

/** Fetch the runtime config once so the UI knows whether to run the free or paid flow. */
export function useConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let alive = true;
    getConfig()
      .then((c) => {
        if (alive) setConfig(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return config;
}
