---
name: wow-artifacts
description: Write each artifact the step expects, at the path it expects, before ending.
---

Before you end, write every artifact this step is expected to produce, each at the path it is expected at. A missing file counts as not done.
{{#expectedArtifacts}}

The expected paths (a * stands for any name):

{{expectedArtifacts}}
{{/expectedArtifacts}}
