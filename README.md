# RT DICOM Pyodide test

Bare-bones prototype: loads a CT series + RTSTRUCT in the browser using Pyodide + pydicom and draws all structures on the CT slices. Files are read locally and never uploaded.

## Secondary + REG
Load a secondary image series (MR/CT/PET) and a DICOM REG file. The secondary is resampled (trilinear) onto the primary CT grid using the registration matrix, so the RTSTRUCT contours overlay both. Press T to toggle. Deformable REG: only the rigid pre/post matrices are applied.

## Planes + structures
Axial / sagittal / coronal reconstructions on the primary grid (A/S/C keys); click to move the crosshair. Secondary is resampled into each plane. Sagittal/coronal structure outlines are built from the axial contours (even-odd fill of plane crossings per slice, traced with d3.contours). Per-structure show/hide, colour and rename (names kept for the upcoming PDF export); global line width.

## Multiple scans + crop
Up to 4 extra scans (5 total). Every loaded REG is added to a frame-of-reference graph, so a scan can be registered to the CT directly or to another loaded scan (e.g. MR2 -> MR1 -> CT); status shows the path or flags it as unregistered. Secondaries are stored float16 to fit several in memory, and uneven slice spacing is handled using each slice's own position.
Crop (applies to every scan and plane): Auto (body, couch excluded; applied on load), to visible structures + margin, or drag a box on any plane. Reset restores the full grid.

## Scan names + notes
Every scan has an editable display name (used in the viewer and, later, the PDF). Notes: "+ Add note", click the point, then click where the text box goes, and type. Each note belongs to one scan + plane + slice. Drag the box header or the dot to reposition; positions are stored in image coordinates so they stay put when cropping or resizing. The notes list jumps to any note.
