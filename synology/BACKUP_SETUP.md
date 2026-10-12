# Protecting the client files on the Synology (for Muse)

The portal backs up its own data (approvals, comments, favorites, campaigns, logins) every
night to `GenvydClients/_Portal backups`. This guide protects the **videos and photos**, which
only exist on the Synology. Do the steps in order and report back what you see in each one.

Do not change the `genvyd-portal` Container Manager project, nginx.conf, the tunnel, or any
Cloudflare settings. None of these steps touch them.

## 1. Check the file system

DSM: **Storage Manager > Storage**. Open the volume that holds `GenvydClients` (Volume 1).

- Report the file system shown: **Btrfs** or **ext4**.
- If it is ext4, skip step 2 (snapshots need Btrfs) and do steps 3 and 4.

## 2. Snapshots (undo for mistakes, takes minutes)

Snapshots are instant "rewind points". They protect against deleting or overwriting a file
by accident, and against ransomware. They are stored on the same drives, so step 3 is still
needed for a drive failure.

1. **Package Center**: install **Snapshot Replication** (free, by Synology).
2. Open it: **Snapshots**, select the **GenvydClients** shared folder, **Settings**.
3. Schedule: turn on, **Daily** at **2:00 AM**. Also add a second schedule every **4 hours**
   between 8:00 AM and 8:00 PM if the option is there.
4. Retention: keep **all snapshots for 7 days**, then **1 per day for 30 days**, then
   **1 per week for 12 weeks**. (Use "Advanced retention policy" if that is how it is worded.)
5. Leave "Make snapshot visible" **off**.
6. Take one snapshot now: select GenvydClients, **Snapshot > Take a snapshot**, description
   `First snapshot`.

## 3. A copy on a second drive (protects against the Synology itself failing)

This needs an external USB drive plugged into the DS920+ (any 2 TB or larger drive is fine;
it is a one-time purchase). If Anthony has not plugged one in yet, stop here and tell him.

1. **Package Center**: install **Hyper Backup** (free, by Synology).
2. **Hyper Backup > + > Data backup task > Local folder & USB**, pick the USB drive.
3. Select the shared folders: **GenvydClients** and **docker** (the portal's container setup).
4. Schedule: **Daily** at **4:00 AM** (after the 3:17 AM portal backup).
5. Turn on **Enable backup rotation**, **Smart Recycle**, keep up to **30** versions.
6. Turn on **integrity check** weekly.
7. Run the task once now (**Back up now**) and report when it finishes.

Paid alternative, only if Anthony asks for it later: Synology C2 Storage as the destination
instead of a USB drive (off-site, survives fire or theft).

## 4. Recycle Bin

**Control Panel > Shared Folder > GenvydClients > Edit**: confirm **Enable Recycle Bin** is
on. (The portal never deletes files, but this catches anything deleted in Finder.)

## Report back

- File system (Btrfs or ext4)
- Snapshot schedule and retention as set, and whether the first snapshot succeeded
- Hyper Backup: destination, schedule, and whether the first run succeeded (or "no USB drive")
- Recycle Bin on or off
