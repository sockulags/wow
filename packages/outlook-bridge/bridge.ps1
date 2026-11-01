# wow Outlook bridge. Reads one JSON request per line on stdin and writes one JSON response per
# line on stdout. Read-only: it attaches to an Outlook that is already running and never starts
# Outlook, changes items or sends mail. "open" only asks Outlook to show an item.
#
# Started by PowershellOutlookSource as:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bridge.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$BridgeVersion = '1'
# Longest mail snippet sent back; the rail shows one line, the rest only costs time on the pipe.
$SnippetChars = 200

$utf8 = New-Object System.Text.UTF8Encoding $false
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"

$script:outlook = $null

function Get-Outlook {
    if ($null -ne $script:outlook) {
        try {
            $null = $script:outlook.Version
            return $script:outlook
        } catch {
            $script:outlook = $null
        }
    }
    try {
        # GetActiveObject attaches to a running Outlook; New-Object -ComObject would start one.
        $script:outlook = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
    } catch {
        $script:outlook = $null
    }
    return $script:outlook
}

function Get-Namespace {
    $app = Get-Outlook
    if ($null -eq $app) { throw 'unavailable::Outlook is not running' }
    return $app.GetNamespace('MAPI')
}

function ConvertTo-IsoOffset([datetime] $value) {
    # Outlook returns local wall-clock times; DateTimeOffset adds the local offset.
    return (New-Object System.DateTimeOffset ($value)).ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertFrom-IsoOffset([string] $value) {
    return [DateTimeOffset]::Parse($value, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime
}

function Format-OutlookDate([datetime] $value) {
    # Restrict parses dates in the user's locale and ignores seconds.
    return $value.ToString('g')
}

function Get-Property($item, [string] $name) {
    try { return $item.$name } catch { return $null }
}

function Find-JoinUrl($body, $location) {
    foreach ($text in @($body, $location)) {
        if ($text -and ([string]$text) -match 'https://teams\.microsoft\.com/l/meetup-join/[^\s"''<>]+') {
            return $Matches[0]
        }
    }
    return $null
}

function ConvertTo-Appointment($item) {
    $location = Get-Property $item 'Location'
    if ($location -eq '') { $location = $null }
    $organizer = Get-Property $item 'Organizer'
    if ($organizer -eq '') { $organizer = $null }
    $status = Get-Property $item 'MeetingStatus'
    return [ordered]@{
        entryId     = [string]$item.EntryID
        subject     = [string]$item.Subject
        start       = ConvertTo-IsoOffset $item.Start
        end         = ConvertTo-IsoOffset $item.End
        location    = $location
        isAllDay    = [bool]$item.AllDayEvent
        isRecurring = [bool]$item.IsRecurring
        # olMeetingCanceled (5) and olMeetingReceivedAndCanceled (7).
        isCancelled = ($status -eq 5 -or $status -eq 7)
        organizer   = $organizer
        joinUrl     = Find-JoinUrl (Get-Property $item 'Body') $location
        busyStatus  = [int]$item.BusyStatus
    }
}

function Invoke-Ping {
    if ($null -eq (Get-Outlook)) {
        return [ordered]@{ version = $BridgeVersion; outlook = 'unavailable'; message = 'Outlook is not running' }
    }
    return [ordered]@{ version = $BridgeVersion; outlook = 'available'; message = $null }
}

function Invoke-Calendar($request) {
    $ns = Get-Namespace
    $from = ConvertFrom-IsoOffset $request.from
    $to = ConvertFrom-IsoOffset $request.to
    $items = $ns.GetDefaultFolder(9).Items
    # Sort before IncludeRecurrences, or occurrences are not expanded.
    $items.Sort('[Start]')
    $items.IncludeRecurrences = $true
    $filter = "[Start] < '{0}' AND [End] > '{1}'" -f (Format-OutlookDate $to), (Format-OutlookDate $from)
    $restricted = $items.Restrict($filter)
    $list = New-Object System.Collections.ArrayList
    $item = $restricted.GetFirst()
    while ($null -ne $item) {
        # Items are sorted by start, and a series without an end date never runs out of
        # occurrences, so stop at the window's end instead of at the last item.
        if ($item.Start -ge $to) { break }
        if ($item.End -gt $from) { [void]$list.Add((ConvertTo-Appointment $item)) }
        $item = $restricted.GetNext()
    }
    return [ordered]@{ items = $list.ToArray() }
}

function Resolve-MailFolder($ns, [string] $name) {
    $inbox = $ns.GetDefaultFolder(6)
    if ($name -eq 'Inbox') { return $inbox }
    try { return $inbox.Folders.Item($name) } catch { }
    try { return $inbox.Parent.Folders.Item($name) } catch { }
    return $null
}

function Invoke-UnreadMail($request) {
    $ns = Get-Namespace
    $limit = [int]$request.limit
    $found = New-Object System.Collections.ArrayList
    $count = 0
    foreach ($name in @($request.folders)) {
        $folder = Resolve-MailFolder $ns ([string]$name)
        if ($null -eq $folder) { continue }
        $unread = $folder.Items.Restrict('[UnRead] = True')
        $count += $unread.Count
        $unread.Sort('[ReceivedTime]', $true)
        $taken = 0
        $item = $unread.GetFirst()
        while ($null -ne $item -and $taken -lt $limit) {
            $received = Get-Property $item 'ReceivedTime'
            if ($null -ne $received) {
                $body = [string](Get-Property $item 'Body')
                $snippet = ($body -replace '\s+', ' ').Trim()
                if ($snippet.Length -gt $SnippetChars) { $snippet = $snippet.Substring(0, $SnippetChars) }
                [void]$found.Add(@{
                    ticks = ([datetime]$received).ToUniversalTime().Ticks
                    value = [ordered]@{
                        entryId    = [string]$item.EntryID
                        folder     = [string]$name
                        from       = [string](Get-Property $item 'SenderName')
                        subject    = [string](Get-Property $item 'Subject')
                        receivedAt = ConvertTo-IsoOffset $received
                        snippet    = $snippet
                    }
                })
                $taken++
            }
            $item = $unread.GetNext()
        }
    }
    $newest = @($found | Sort-Object -Property { $_.ticks } -Descending | Select-Object -First $limit | ForEach-Object { $_.value })
    return [ordered]@{ items = $newest; unreadCount = $count }
}

function Invoke-Open($request) {
    $ns = Get-Namespace
    $ns.GetItemFromID([string]$request.entryId).Display()
    return [ordered]@{ opened = $true }
}

function Get-ErrorInfo($record) {
    $exception = $record.Exception
    $message = $exception.Message
    if ($message -match '^(unavailable|bad_request)::(.*)$') {
        return @($Matches[1], $Matches[2])
    }
    $com = [System.Runtime.InteropServices.COMException]
    if ($exception -is $com -or $exception.InnerException -is $com) {
        # Outlook closed or restarted under us; attach again on the next request.
        $script:outlook = $null
        return @('unavailable', "Outlook did not answer: $message")
    }
    return @('failed', $message)
}

function Write-Response($value) {
    $stdout.WriteLine(($value | ConvertTo-Json -Compress -Depth 8))
}

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $id = $null
    try {
        $request = $line | ConvertFrom-Json
        $id = $request.id
        $result = switch ([string]$request.op) {
            'ping' { Invoke-Ping }
            'calendar' { Invoke-Calendar $request }
            'unreadMail' { Invoke-UnreadMail $request }
            'open' { Invoke-Open $request }
            default { throw "bad_request::Unknown op '$($request.op)'" }
        }
        Write-Response ([ordered]@{ id = $id; result = $result })
    } catch {
        $code, $message = Get-ErrorInfo $_
        Write-Response ([ordered]@{ id = $id; error = [ordered]@{ code = $code; message = $message } })
    }
}
