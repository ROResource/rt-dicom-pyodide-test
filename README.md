# RT DICOM Pyodide test

Bare-bones prototype: loads a CT series + RTSTRUCT in the browser using Pyodide + pydicom and draws all structures on the CT slices. Files are read locally and never uploaded.

## Secondary + REG
Load a secondary image series (MR/CT/PET) and a DICOM REG file. The secondary is resampled (trilinear) onto the primary CT grid using the registration matrix, so the RTSTRUCT contours overlay both. Press T to toggle. Deformable REG: only the rigid pre/post matrices are applied.

## Planes + structures
Axial / sagittal / coronal reconstructions on the primary grid (A/S/C keys); click to move the crosshair. Secondary is resampled into each plane. Sagittal/coronal structure outlines are built from the axial contours (even-odd fill of plane crossings per slice, traced with d3.contours). Per-structure show/hide, colour and rename; global line width; "Download renamed RTSTRUCT" writes names/colours into a copy with a new SOP Instance UID.
