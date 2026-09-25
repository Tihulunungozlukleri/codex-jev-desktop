using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

// Compiled as a Windows application: neither the supervisor nor Node opens a console.
public static class JevSupervisor {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessTime, PerJobTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly object LogLock = new object();
    static string logPath;
    static void Log(string message) {
        if (String.IsNullOrEmpty(message)) return;
        lock (LogLock) {
            try {
                if (File.Exists(logPath) && new FileInfo(logPath).Length > 1048576) {
                    if (File.Exists(logPath + ".1")) File.Delete(logPath + ".1");
                    File.Move(logPath, logPath + ".1");
                }
                File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            } catch { /* Logging failure must not stop the relay. */ }
        }
    }
    public static int Main(string[] args) {
        if (args.Length != 3) return 2;
        IntPtr job = IntPtr.Zero;
        try {
            Directory.CreateDirectory(args[2]);
            logPath = Path.Combine(args[2], "supervisor.log");
            job = CreateJobObject(IntPtr.Zero, null);
            var limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Exception("job_setup_failed");
            Log("supervisor_started pid=" + Process.GetCurrentProcess().Id);
            while (true) {
                var start = new ProcessStartInfo(args[0], "\"" + args[1] + "\" serve");
                start.WorkingDirectory = Path.GetDirectoryName(args[1]);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                using (var child = new Process()) {
                    child.StartInfo = start;
                    child.OutputDataReceived += (sender, item) => Log(item.Data);
                    child.ErrorDataReceived += (sender, item) => Log(item.Data);
                    child.Start();
                    // Kernel ownership ensures stopping the task cannot leave an orphan Node process.
                    if (!AssignProcessToJobObject(job, child.Handle)) {
                        child.Kill(); child.WaitForExit();
                        throw new Exception("job_assignment_failed");
                    }
                    Log("relay_started pid=" + child.Id);
                    child.BeginOutputReadLine(); child.BeginErrorReadLine();
                    child.WaitForExit();
                    Log("relay_exited code=" + child.ExitCode + "; restarting_in_seconds=3");
                }
                Thread.Sleep(3000);
            }
        } catch (Exception error) {
            Log("supervisor_failed type=" + error.GetType().Name + " code=" + Marshal.GetLastWin32Error());
            return 1;
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
