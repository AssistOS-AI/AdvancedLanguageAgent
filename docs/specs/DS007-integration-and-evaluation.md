---
id: DS007
title: Integration and evaluation
status: active
owner: ALA maintainers
summary: Defines standalone and Ploinky operation, independent configuration, and comparative routing evaluation.
---

## Introduction

ALA must operate inside and outside Ploinky while preserving the same CLI task
contract. Routing behavior must be evaluated across explicit, default, and
symbolic-first selection paths.

## Core Content

User-level configuration must be available from the current user's environment.
ALA must reuse AchillesAgentLib model configuration and tags when available and
must permit manual runtime overrides. Task-repository configuration must remain
independent from ALA installation so a deployment can install only required task
families.

As a Ploinky agent, ALA may expose the same operations through Ploinky CLI, router,
and WebChat integrations. Ploinky agents may also act as executors when their
advertised capabilities satisfy an A-Skill's requirements. Standalone ALA operation
must not depend on Ploinky.

Evaluation must compare explicit selection, default MainAgent-compatible detection,
and symbolic-first detection. The same corpus must include canonical instructions,
paraphrases, multilingual requests, spelling errors, ambiguous requests, multi-step
tasks, missing parameters, and unsupported tasks.

Symbolic evaluation must report correct direct routing, incorrect direct routing,
abstention rate, fallback rate, and final correctness after fallback. Evaluation
must assign a greater cost to false confident selection than to abstention because a
false direct route bypasses the safe default selector with the wrong method.

Concrete configuration locations, remote-agent protocols, workspace-retention
values, retry counts, and diagnostic schemas remain distribution-owned contracts.
Each distribution must define those values while preserving portability, bounded
work, secure credential handling, and result-stream separation.

## Conclusion

ALA integrations must preserve a common task interface and must measure routing in
a way that rewards correct direct selection and safe fallback.
