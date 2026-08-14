---
title: DS003-main-behavior
summary: Defines the project-spanning request, task-selection, and capability-execution behaviors that produce an ALA result.
---

## Introduction

ALA's primary purpose is to let a human or agent submit a language-oriented task through one CLI and receive the requested result without directly integrating AchillesAgentLib or execution providers. This specification contains only the defining end-to-end behaviors and their system-wide boundaries.

## Core Content

The first defining behavior is request execution and result delivery. A human or agent initiates it by submitting an instruction and optional payload in interactive or single-shot mode. ALA must accept the request, select the task path, execute the selected method, and write the requested result to standard output or a file. Diagnostics and routing data must remain outside the result stream for every task repository and backend.

The second defining behavior is task-repository discovery and A-Skill selection. Configured task repositories must contribute their semantic descriptions and AchillesAgentLib skills as routing candidates. Explicit task or A-Skill selection must take precedence. Otherwise ALA must use MainAgent-compatible selection, optionally after a symbolic router supplies sufficiently clear evidence. Uncertain symbolic evidence must fall back instead of forcing a task.

The third defining behavior is capability-based execution. The selected A-Skill must retain ownership of task methodology and acceptance conditions while ALA maps its requirements to an eligible model, authenticated agent, research facility, or isolated workspace. ALA must perform the requested work, apply bounded verification and feedback when required, and return the observable task result without absorbing the domain method into generic runtime infrastructure.

Ploinky hosting, individual skill families, symbolic confidence states, model tiers, workspace retention, and evaluation metrics are specialized contracts beneath these behaviors. DS002 and DS004 through DS007 define those details without turning this specification into a feature catalogue.

The accepted behavior set is grounded in the user-confirmed ALA design contract. This repository contains no runtime implementation, manifest, or tests, so concrete command names and implementation algorithms are outside the evidence boundary.

## Conclusion

ALA fulfills its purpose by accepting one request, safely selecting an independently supplied A-Skill, and executing its requirements through an eligible backend while preserving a clean result channel.
