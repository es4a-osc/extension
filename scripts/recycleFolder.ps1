# Windows 项目树文件夹静默回收助手；不提权、不显示 Shell UI、不允许永久删除。
# xhwsd@qq.com 2026-10-9
param([Parameter(Mandatory = $true)][string]$TargetPathBase64)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
	Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace ES4A {
	// COM 方法必须按 Windows SDK 的 vtable 顺序声明；未调用的方法也必须保留。
	[ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IFileOperation {
		[PreserveSig] int Advise(IntPtr sink, out uint cookie);
		[PreserveSig] int Unadvise(uint cookie);
		[PreserveSig] int SetOperationFlags(uint flags);
		[PreserveSig] int SetProgressMessage(IntPtr message);
		[PreserveSig] int SetProgressDialog(IntPtr dialog);
		[PreserveSig] int SetProperties(IntPtr properties);
		[PreserveSig] int SetOwnerWindow(IntPtr window);
		[PreserveSig] int ApplyPropertiesToItem(IntPtr item);
		[PreserveSig] int ApplyPropertiesToItems(IntPtr items);
		[PreserveSig] int RenameItem(IntPtr item, IntPtr name, IntPtr sink);
		[PreserveSig] int RenameItems(IntPtr items, IntPtr name);
		[PreserveSig] int MoveItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
		[PreserveSig] int MoveItems(IntPtr items, IntPtr destination);
		[PreserveSig] int CopyItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
		[PreserveSig] int CopyItems(IntPtr items, IntPtr destination);
		[PreserveSig] int DeleteItem(IntPtr item, IFileOperationProgressSink sink);
		[PreserveSig] int DeleteItems(IntPtr items);
		[PreserveSig] int NewItem(IntPtr destination, uint attributes, IntPtr name, IntPtr template, IntPtr sink);
		[PreserveSig] int PerformOperations();
		[PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
	}

	[ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	public interface IFileOperationProgressSink {
		[PreserveSig] int StartOperations();
		[PreserveSig] int FinishOperations(int result);
		[PreserveSig] int PreRenameItem(uint flags, IntPtr item, IntPtr name);
		[PreserveSig] int PostRenameItem(uint flags, IntPtr item, IntPtr name, int result, IntPtr created);
		[PreserveSig] int PreMoveItem(uint flags, IntPtr item, IntPtr destination, IntPtr name);
		[PreserveSig] int PostMoveItem(uint flags, IntPtr item, IntPtr destination, IntPtr name, int result, IntPtr created);
		[PreserveSig] int PreCopyItem(uint flags, IntPtr item, IntPtr destination, IntPtr name);
		[PreserveSig] int PostCopyItem(uint flags, IntPtr item, IntPtr destination, IntPtr name, int result, IntPtr created);
		[PreserveSig] int PreDeleteItem(uint flags, IntPtr item);
		[PreserveSig] int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr created);
		[PreserveSig] int PreNewItem(uint flags, IntPtr destination, IntPtr name);
		[PreserveSig] int PostNewItem(uint flags, IntPtr destination, IntPtr name, IntPtr template, uint attributes, int result, IntPtr created);
		[PreserveSig] int UpdateProgress(uint total, uint completed);
		[PreserveSig] int ResetTimer();
		[PreserveSig] int PauseTimer();
		[PreserveSig] int ResumeTimer();
	}

	[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
	public sealed class RecycleOnlySink : IFileOperationProgressSink {
		const uint TSF_DELETE_RECYCLE_IF_POSSIBLE = 0x80;
		const int E_ABORT = unchecked((int)0x80004004);
		public int Result = E_ABORT;
		public bool Recycled;
		public int PreDeleteItem(uint flags, IntPtr item) {
			// Shell 要改为永久删除时，在任何删除发生前终止整次操作。
			return (flags & TSF_DELETE_RECYCLE_IF_POSSIBLE) != 0 ? 0 : E_ABORT;
		}
		public int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr created) {
			Result = result;
			Recycled = result >= 0 && (flags & TSF_DELETE_RECYCLE_IF_POSSIBLE) != 0;
			return 0;
		}
		public int StartOperations() { return 0; }
		public int FinishOperations(int result) { return 0; }
		public int PreRenameItem(uint flags, IntPtr item, IntPtr name) { return 0; }
		public int PostRenameItem(uint flags, IntPtr item, IntPtr name, int result, IntPtr created) { return 0; }
		public int PreMoveItem(uint flags, IntPtr item, IntPtr destination, IntPtr name) { return 0; }
		public int PostMoveItem(uint flags, IntPtr item, IntPtr destination, IntPtr name, int result, IntPtr created) { return 0; }
		public int PreCopyItem(uint flags, IntPtr item, IntPtr destination, IntPtr name) { return 0; }
		public int PostCopyItem(uint flags, IntPtr item, IntPtr destination, IntPtr name, int result, IntPtr created) { return 0; }
		public int PreNewItem(uint flags, IntPtr destination, IntPtr name) { return 0; }
		public int PostNewItem(uint flags, IntPtr destination, IntPtr name, IntPtr template, uint attributes, int result, IntPtr created) { return 0; }
		public int UpdateProgress(uint total, uint completed) { return 0; }
		public int ResetTimer() { return 0; }
		public int PauseTimer() { return 0; }
		public int ResumeTimer() { return 0; }
	}

	public static class FolderRecycler {
		const uint FOF_SILENT = 0x0004;
		const uint FOF_NOCONFIRMATION = 0x0010;
		const uint FOF_NOERRORUI = 0x0400;
		const uint FOFX_RECYCLEONDELETE = 0x00080000;
		const uint FOFX_EARLYFAILURE = 0x00100000;
		const uint FOFX_ADDUNDORECORD = 0x20000000;

		[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
		static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IntPtr item);

		public static void Recycle(string path) {
			if (!Path.IsPathRooted(path) || !Directory.Exists(path))
				throw new IOException("Folder does not exist.");
			path = Path.GetFullPath(path);
			if (String.Equals(path.TrimEnd('\\'), Path.GetPathRoot(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
				throw new IOException("Cannot recycle a drive root.");
			IntPtr item = IntPtr.Zero;
			IFileOperation operation = null;
			try {
				Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
				Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item));
				operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
				// 明确关闭进度、确认和错误窗口；不设置 SHOWELEVATIONPROMPT，也不请求提权。
				Marshal.ThrowExceptionForHR(operation.SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI |
					FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE | FOFX_ADDUNDORECORD));
				RecycleOnlySink sink = new RecycleOnlySink();
				Marshal.ThrowExceptionForHR(operation.DeleteItem(item, sink));
				Marshal.ThrowExceptionForHR(operation.PerformOperations());
				bool aborted;
				Marshal.ThrowExceptionForHR(operation.GetAnyOperationsAborted(out aborted));
				Marshal.ThrowExceptionForHR(sink.Result);
				if (aborted || !sink.Recycled || Directory.Exists(path))
					throw new IOException("Folder was not recycled.");
				GC.KeepAlive(sink);
			} finally {
				if (operation != null) Marshal.FinalReleaseComObject(operation);
				if (item != IntPtr.Zero) Marshal.Release(item);
			}
		}
	}
}
'@
	$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetPathBase64))
	[ES4A.FolderRecycler]::Recycle($targetPath)
	exit 0
} catch {
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
