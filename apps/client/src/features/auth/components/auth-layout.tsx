import React from "react";
import { Box } from "@mantine/core";
import classes from "./auth.module.css";
import { WebpartMark } from "@/components/ui/webpart-mark.tsx";
import webpartLogoBlack from "@/assets/brand/webpart-logo-black.png";
import webpartLogoWhite from "@/assets/brand/webpart-logo-white.png";

type AuthLayoutProps = {
  children: React.ReactNode;
};

// Webpart: same layout as the tasks.webpart.ro login (wordmark + two-column card).
export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className={classes.page}>
      <div className={classes.logo}>
        <Box
          component="img"
          src={webpartLogoBlack}
          alt="Webpart"
          className={classes.wordmark}
          darkHidden
        />
        <Box
          component="img"
          src={webpartLogoWhite}
          alt="Webpart"
          className={classes.wordmark}
          lightHidden
        />
      </div>
      <div className={classes.card}>
        <section className={classes.brandPanel} aria-hidden="true">
          <WebpartMark className={classes.brandMark} />
          <div>
            <p className={classes.brandEyebrow}>Webpart Docs</p>
            <p className={classes.brandTitle}>Welcome back</p>
          </div>
        </section>
        <main className={classes.formPanel}>{children}</main>
      </div>
    </div>
  );
}
