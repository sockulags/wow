# wow Outlook bridge. Reads one JSON request per line on stdin and writes one JSON response per
# line on stdout. Read-only: it attaches to an Outlook that is already running and never starts
# Outlook or changes items. It reads the calendar and nothing else: "open" only asks Outlook to
# show a meeting, and "profile" only reads the calendar's work hours, time zone, first day of the
# week and the user's address.
#
# Started by PowershellOutlookSource as:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bridge.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$BridgeVersion = '1'
# Longest meeting body sent back; the server keeps a short snippet of it for the calendar.
$BodyChars = 2000
# Outlook's olFolderCalendar, olIdentifyByMessageClass and PR_ROAMING_XMLSTREAM.
$CalendarFolder = 9
$IdentifyByMessageClass = 2
$RoamingXmlStream = 'http://schemas.microsoft.com/mapi/proptag/0x7C080102'

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
    $body = [string](Get-Property $item 'Body')
    if ($body.Length -gt $BodyChars) { $body = $body.Substring(0, $BodyChars) }
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
        body        = $(if ($body -eq '') { $null } else { $body })
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

function Invoke-Open($request) {
    $ns = Get-Namespace
    $ns.GetItemFromID([string]$request.entryId).Display()
    return [ordered]@{ opened = $true }
}

# Each part is read on its own and is null when Outlook does not have it, so a profile without
# work hours still reports its time zone.
function Read-WorkHoursXml($ns) {
    try {
        # GetStorage hands back an unsaved empty item when the message does not exist; nothing is
        # saved here, so Outlook is not changed.
        $storage = $ns.GetDefaultFolder($CalendarFolder).GetStorage('IPM.Configuration.WorkHours', $IdentifyByMessageClass)
        $bytes = $storage.PropertyAccessor.GetProperty($RoamingXmlStream)
        if ($null -eq $bytes) { return $null }
        return $utf8.GetString([byte[]]$bytes)
    } catch {
        return $null
    }
}

function Read-UserAddress($ns) {
    try {
        $entry = $ns.CurrentUser.AddressEntry
        $exchange = $entry.GetExchangeUser()
        if ($null -ne $exchange) { return [string]$exchange.PrimarySmtpAddress }
        return [string]$entry.Address
    } catch {
        return $null
    }
}

function Invoke-Profile {
    $ns = Get-Namespace
    $zone = $null
    try { $zone = [string](Get-Outlook).TimeZones.CurrentTimeZone.ID } catch { }
    $firstDay = $null
    # Outlook starts the week on the day of the user's Windows region unless it is changed there.
    try { $firstDay = [int](Get-Culture).DateTimeFormat.FirstDayOfWeek } catch { }
    return [ordered]@{
        timeZoneId     = $zone
        workHoursXml   = Read-WorkHoursXml $ns
        firstDayOfWeek = $firstDay
        address        = Read-UserAddress $ns
    }
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
            'open' { Invoke-Open $request }
            'profile' { Invoke-Profile }
            default { throw "bad_request::Unknown op '$($request.op)'" }
        }
        Write-Response ([ordered]@{ id = $id; result = $result })
    } catch {
        $code, $message = Get-ErrorInfo $_
        Write-Response ([ordered]@{ id = $id; error = [ordered]@{ code = $code; message = $message } })
    }
}
