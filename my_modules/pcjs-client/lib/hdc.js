/**
 * @fileoverview Implements the PCjs Hard Drive Controller (HDC) component.
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @version 1.0
 * @suppress {missingProperties}
 * Created 2012-Nov-26
 *
 * Copyright © 2012-2014 Jeff Parsons <Jeff@pcjs.org>
 *
 * This file is part of PCjs, which is part of the JavaScript Machines Project (aka JSMachines)
 * at <http://jsmachines.net/> and <http://pcjs.org/>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every source code file of every
 * copy or modified version of this work, and to display that copyright notice on every screen
 * that loads or runs any version of this software (see Computer.sCopyright).
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of the
 * PCjs program for purposes of the GNU General Public License, and the author does not claim
 * any copyright as to their contents.
 */

"use strict";

if (typeof module !== 'undefined') {
    var str = require("../../shared/lib/strlib");
    var web = require("../../shared/lib/weblib");
    var DiskAPI = require("../../shared/lib/diskapi");
    var Component = require("../../shared/lib/component");
    var ChipSet = require("./chipset");
    var Disk = require("./disk");
    var State = require("./state");
}

/**
 * HDC(parmsHDC)
 *
 * The HDC component simulates an STC-506/412 interface to an IBM-compatible fixed disk drive. The first
 * such drive was a 10Mb 5.25-inch drive containing two platters and 4 heads. Data spanned 306 cylinders
 * for a total of 1224 tracks, with 17 sectors/track and 512 bytes/sector.
 *
 * HDC supports the following component-specific properties:
 *
 *      drives: an array of driveConfig objects, each containing 'name', 'path', 'size' and 'type' properties
 *      type:   either 'xt' (for the PC XT Xebec controller) or 'at' (for the PC AT Western Digital controller)
 *      
 * The 'type' parameter defaults to 'xt'.  All ports for the PC XT controller are referred to as XTC ports,
 * and similarly, all PC AT controller ports are referred to as ATC ports.
 *
 * If 'path' is empty, a scratch disk image is created; otherwise, we make a note of the path, but we will NOT
 * pre-load it like we do for floppy disk images.
 *
 * My current plan is to read all disk data on-demand, keeping a cache of what we've read, and possibly adding
 * some read-ahead as well. Any portions of the disk image that are written before being read will never be read.
 *
 * TRIVIA: On p.1-179 of the PC XT Technical Reference Manual (revised APR83), it reads:
 *
 *      "WARNING: The last cylinder on the fixed disk drive is reserved for diagnostic use.
 *      Diagnostic write tests will destroy any data on this cylinder."
 *
 * Does FDISK insure that the last cylinder is reserved?  I'm sure we'll eventually find out.
 * 
 * @constructor
 * @extends Component
 * @param {Object} parmsHDC
 */
function HDC(parmsHDC) {

    Component.call(this, "HDC", parmsHDC, HDC);

    this['dmaRead'] = this.dmaRead;
    this['dmaWrite'] = this.dmaWrite;
    this['dmaWriteBuffer'] = this.dmaWriteBuffer;
    this['dmaWriteFormat'] = this.dmaWriteFormat;

    this.aDriveConfigs = [];

    if (parmsHDC['drives']) {
        try {
            /*
             * The most likely source of any exception will be right here, where we're parsing
             * the JSON-encoded disk data.
             */
            this.aDriveConfigs = eval("(" + parmsHDC['drives'] + ")");
            /*
             * Nothing more to do with aDriveConfigs now. initController() and autoMount() (if there are
             * any disk image "path" properties to process) will take care of the rest.
             */
        } catch (e) {
            this.error("HDC drive configuration error: " + e.message + " (" + parmsHDC['drives'] + ")");
        }
    }
    
    /*
     * Set fATC (AT Controller flag) according to the 'type' parameter.  This in turn determines other
     * defaults.  For example, the default XT drive type is 3 (for a 10Mb disk drive), whereas the default
     * AT drive type is 2 (for a 20Mb disk drive).
     */
    this.fATC = (parmsHDC['type'] == "at");
    this.iHDC = this.fATC? 1 : 0;
    this.iDriveTypeDefault = this.fATC? 2 : 3;
    
    /*
     * The remainder of HDC initialization now takes place in our initBus() handler
     */
}

Component.subclass(Component, HDC);

/*
 * HDC defaults, in case drive parameters weren't specified
 */
HDC.DEFAULT_DRIVE_NAME = "Hard Drive";

/*
 * Each of the following DriveType entries contain (up to) 4 values:
 * 
 *      [0]: total cylinders
 *      [1]: total heads
 *      [2]: total sectors/tracks (optional; default is 17)
 *      [3]: total bytes/sector (optional; default is 512)
 *      
 * verifyDrive() attempts to confirm that these values agree with the programmed drive characteristics.
 */
HDC.aDriveTypes = [
    {
        0x00: [306, 2],
        0x01: [375, 8],
        0x02: [306, 6],
        0x03: [306, 4]         // <= default 'xt' drive type (10Mb)
    },
    /*
     * Sadly, drive types differ across controller models (XTC drive types don't match ATC drive types),
     * so aDriveTypes must first be indexed by a controller index (this.iHDC).
     * 
     * The following is a more complete description of the drive types supported by the MODEL_5170, where C is
     * Cylinders, H is Heads, WP is Write Pre-Comp, and LZ is Landing Zone (in practice, we don't need WP or LZ).  
     * 
     * Type    C    H   WP   LZ
     * ----  ---   --  ---  ---
     *   1   306    4  128  305
     *   2   615    4  300  615
     *   3   615    6  300  615
     *   4   940    8  512  940
     *   5   940    6  512  940
     *   6   615    4   no  615
     *   7   462    8  256  511
     *   8   733    5   no  733
     *   9   900   15  no8  901
     *  10   820    3   no  820
     *  11   855    5   no  855
     *  12   855    7   no  855
     *  13   306    8  128  319
     *  14   733    7   no  733
     *  15  (reserved--all zeros)
     */
    {
        0x01: [306, 4],
        0x02: [615, 4],         // <= default 'at' drive type (20Mb)
        0x03: [615, 6],
        0x04: [940, 8],
        0x05: [940, 6],
        0x06: [615, 4],
        0x07: [462, 8],
        0x08: [733, 5],
        0x09: [900,15],
        0x0A: [820, 3],
        0x0B: [855, 5],
        0x0C: [855, 7],
        0x0D: [306, 8],
        0x0E: [733, 7]
    }
];

/*
 * ATC (AT Controller) Registers
 * 
 * The "IBM Personal Computer AT Fixed Disk and Diskette Drive Adapter", aka the HFCOMBO card, contains what we refer
 * to here as the ATC (AT Controller).  Even though that card contains both Fixed Disk and Diskette Drive controllers,
 * this component (HDC) still deals only with the "Fixed Disk" portion.  Fortunately, the "Diskette Drive Adapter"
 * portion of the card is compatible with the existing FDC component, so that component continues to be responsible
 * for all diskette operations.
 * 
 * ATC ports default to their primary addresses; secondary port addresses are 0x80 lower (eg, 0x170 instead of 0x1F0).
 * 
 * It's important to know that the MODEL_5170 BIOS has a special relationship with the "Combo Hard File/Diskette
 * (HFCOMBO) Card" (see @F000:144C).  Initially, the ChipSet component intercepted reads for HFCOMBO's STATUS port
 * and returned the BUSY bit clear to reduce boot time; however, it turned out that was also a prerequisite for the
 * BIOS to write test patterns to the CYLLO port and set the "DUAL" bit (bit 0) of the "HFCNTRL" byte at 40:8Fh if
 * those CYLLO operations succeeded (now that the HDC is "ATC-aware", those ChipSet port intercepts have been removed).
 * 
 * Without the "DUAL" bit set, when it came time later to report the diskette drive type, the "DISK_TYPE" function
 * (@F000:273D) would branch to one of two almost-identical blocks of code -- specifically, a block that disallowed
 * diskette drive types >= 2 (ChipSet.CMOS.FDRIVE.DSDD) instead of >= 3 (ChipSet.CMOS.FDRIVE.DSHD).
 * 
 * In other words, the "Fixed Disk" portion of the HFCOMBO controller has to be present and operational if the user
 * wants to use high-capacity (80-track) diskettes with "Diskette Drive" portion of the controller.  This may not be
 * immediately obvious to anyone creating a 5170 machine configuration with the FDC component but no HDC component.
 * 
 * TODO: Investigate what a MODEL_5170 can do, if anything, with diskettes if an "HFCOMBO card" was NOT installed
 * (eg, was there Diskette-only Controller that could be installed, and if so, did it support high-capacity diskettes?)
 * Also, consider making the FDC component able to detect when the HDC is missing and provide the same minimal HFCOMBO
 * port intercepts that ChipSet once provided (this is not a compatibility requirement, just a usability improvement).
 */
HDC.ATC = {
    DATA:   { PORT: 0x1F0},     // no register (read-write)
    DIAG:   {                   // this.regError (read-only)
        PORT:       0x1F1,
        NO_ERROR:   0x01,
        CTRL_ERROR: 0x02,
        SEC_ERROR:  0x03,
        ECC_ERROR:  0x04,
        PROC_ERROR: 0x05
    },
    ERROR: {                    // this.regError (read-only)
        PORT:       0x1F1,
        NO_DAM:     0x01,       // Data Address Mark (DAM) not found
        NO_TRK0:    0x02,       // Track 0 not detected
        CMD_ABORT:  0x04,       // Aborted Command
        NO_CHS:     0x10,       // ID field with the specified C:H:S not found
        ECC_ERR:    0x40,       // Data ECC Error
        BAD_BLOCK:  0x80        // Bad Block Detect
    },
    WPREC:  { PORT: 0x1F1},     // this.regWPreC (write-only)
    SECCNT: { PORT: 0x1F2},     // this.regSecCnt (read-write; 0 implies a 256-sector request)
    SECNUM: { PORT: 0x1F3},     // this.regSecNum (read-write)
    CYLLO:  { PORT: 0x1F4},     // this.regCylLo (read-write; all 8 bits are used)
    CYLHI:  {                   // this.regCylHi (read-write; only bits 0-1 are used, for a total of 10 bits, or 1024 max cylinders)
        PORT:       0x1F5,
        MASK:       0x03
    },
    DRVHD:  {                   // this.regDrvHd (read-write)
        PORT:       0x1F6,
        HEAD_MASK:  0x0F,       // set this to the max number of heads before issuing a SET PARAMETERS command
        DRIVE_MASK: 0x10,
        SET_MASK:   0xE0,
        SET_BITS:   0xA0        // for whatever reason, these bits must always be set
    },     
    STATUS: {                   // this.regStatus (read-only; reading clears IRQ.ATC)
        PORT:       0x1F7,
        BUSY:       0x80,       // if this is set, no other STATUS bits are valid
        READY:      0x40,       // if this is set (along with the SEEK_OK bit), the drive is ready to read/write/seek again
        WFAULT:     0x20,       // write fault
        SEEK_OK:    0x10,       // seek operation complete
        DATA_REQ:   0x08,       // indicates that "the sector buffer requires servicing during a Read or Write command. If either bit 7 (BUSY) or this bit is active, a command is being executed. Upon receipt of any command, this bit is reset."
        CORRECTED:  0x04,
        INDEX:      0x02,       // set once for every revolution of the disk
        ERROR:      0x01        // set when the previous command ended in an error; one or more bits are set in the ERROR register (the next command to the controller resets the ERROR bit)
    },
    COMMAND:{                   // this.regCommand (write-only) 
        PORT:       0x1F7,
        RESTORE:    0x10,       // low nibble x 500us equal stepping rate (except for 0, which corresponds to 35us) (aka RECALIBRATE)
        READ_DATA:  0x20,       // also supports NO_RETRIES and WITH_ECC
        WRITE_DATA: 0x30,       // also supports NO_RETRIES and WITH_ECC
        READ_VERF:  0x40,       // also supports NO_RETRIES
        FORMAT_TRK: 0x50,
        SEEK:       0x70,       // low nibble x 500us equal stepping rate (except for 0, which corresponds to 35us)
        DIAGNOSE:   0x90,
        SETPARMS:   0x91,
        NO_RETRIES: 0x01,
        WITH_ECC:   0x02,
        MASK:       0xF0
    }
};

/*
 * XTC (XT Controller) Registers
 */

/*
 * XTC Data Register (0x320, read-write)
 * 
 * Writes to this register are discussed below; see HDC Commands.
 * 
 * Reads from this register after a command has been executed retrieve a "status byte",
 * which must NOT be confused with the Status Register (see below).  This data "status byte"
 * contains only two bits of interest: XTC_DATA.STATUS_ERROR and XTC_DATA.STATUS_UNIT.
 */
HDC.XTC = {};
HDC.XTC.DATA = {};
HDC.XTC.DATA.PORT           = 0x320;    // port address
HDC.XTC.DATA.STATUS_OK      = 0x00;     // no error
HDC.XTC.DATA.STATUS_ERROR   = 0x02;     // error occurred during command execution
HDC.XTC.DATA.STATUS_UNIT    = 0x20;     // logical unit number of the drive

/*
 * XTC Status Register (0x321, read-only)
 * 
 * WARNING: The IBM Technical Reference Manual *badly* confuses the XTC_DATA "status byte" (above)
 * that the controller sends following an HDC.XTC.DATA.CMD operation with the Status Register (below).
 * In fact, it's so badly confused that it completely fails to document any of the Status Register
 * bits below; I'm forced to guess at their meanings from the HDC BIOS listing.
 */
HDC.XTC.STATUS = {};
HDC.XTC.STATUS.PORT         = 0x321;    // port address
HDC.XTC.STATUS.NONE         = 0x00;
HDC.XTC.STATUS.REQ          = 0x01;     // HDC BIOS: request bit
HDC.XTC.STATUS.IOMODE       = 0x02;     // HDC BIOS: mode bit (GUESS: set whenever XTC_DATA contains a response?)
HDC.XTC.STATUS.BUS          = 0x04;     // HDC BIOS: command/data bit (GUESS: set whenever XTC_DATA ready for request?)
HDC.XTC.STATUS.BUSY         = 0x08;     // HDC BIOS: busy bit
HDC.XTC.STATUS.INTERRUPT    = 0x20;     // HDC BIOS: interrupt bit

/*
 * XTC Config Register (0x322, read-only)
 * 
 * This register is used to read HDC card switch settings that defined the "Drive Type" for
 * drives 0 and 1.  SW[1],SW[2] (for drive 0) and SW[3],SW[4] (for drive 1) are set as follows:
 * 
 *      ON,  ON     Drive Type 0   (306 cylinders, 2 heads) 
 *      ON,  OFF    Drive Type 1   (375 cylinders, 8 heads)
 *      OFF, ON     Drive Type 2   (306 cylinders, 6 heads)
 *      OFF, OFF    Drive Type 3   (306 cylinders, 4 heads)
 */

/*
 * XTC Commands, as issued to XTC_DATA
 * 
 * Commands are multi-byte sequences sent to XTC_DATA, starting with a XTC_DATA.CMD byte,
 * and followed by 5 more bytes, for a total of 6 bytes, which collectively are called a
 * Device Control Block (DCB).  Not all commands use all 6 bytes, but all 6 bytes must be present;
 * unused bytes are simply ignored.
 * 
 *      XTC_DATA.CMD    (3-bit class code, 5-bit operation code)
 *      XTC_DATA.HEAD   (1-bit drive number, 5-bit head number)
 *      XTC_DATA.CLSEC  (upper bits of 10-bit cylinder number, 6-bit sector number)
 *      XTC_DATA.CH     (lower bits of 10-bit cylinder number)
 *      XTC_DATA.COUNT  (8-bit interleave or block count)
 *      XTC_DATA.CTRL   (8-bit control field)
 *      
 * One command, HDC.XTC.DATA.CMD.INIT_DRIVE, must include 8 additional bytes following the DCB:
 * 
 *      maximum number of cylinders (high)
 *      maximum number of cylinders (low)
 *      maximum number of heads
 *      start reduced write current cylinder (high)
 *      start reduced write current cylinder (low)
 *      start write precompensation cylinder (high)
 *      start write precompensation cylinder (low)
 *      maximum ECC data burst length
 *      
 * Note that the 3 word values above are stored in "big-endian" format (high byte followed by low byte),
 * rather than the more typical "little-endian" format (low byte followed by high byte).
 */
HDC.XTC.DATA.CMD = {
    TEST_READY:     0x00,       // Test Drive Ready
    RECALIBRATE:    0x01,       // Recalibrate
    REQUEST_SENSE:  0x03,       // Request Sense Status
    FORMAT_DRIVE:   0x04,       // Format Drive
    READ_VERF:      0x05,       // Read Verify
    FORMAT_TRK:     0x06,       // Format Track
    FORMAT_BAD:     0x07,       // Format Bad Track
    READ_DATA:      0x08,       // Read
    WRITE_DATA:     0x0A,       // Write
    SEEK:           0x0B,       // Seek
    INIT_DRIVE:     0x0C,       // Initialize Drive Characteristics
    READ_ECC_BURST: 0x0D,       // Read ECC Burst Error Length
    READ_BUFFER:    0x0E,       // Read Data from Sector Buffer
    WRITE_BUFFER:   0x0F,       // Write Data to Sector Buffer
    RAM_DIAGNOSTIC: 0xE0,       // RAM Diagnostic
    DRV_DIAGNOSTIC: 0xE3,       // HDC BIOS: CHK_DRV_CMD
    CTL_DIAGNOSTIC: 0xE4,       // HDC BIOS: CNTLR_DIAG_CMD
    READ_LONG:      0xE5,       // HDC BIOS: RD_LONG_CMD
    WRITE_LONG:     0xE6        // HDC BIOS: WR_LONG_CMD
};

/*
 * HDC error conditions, as returned in byte 0 of the (4) bytes returned by the Request Sense Status command
 */
HDC.XTC.DATA.ERR = {
	NONE:           0x00,
	NO_INDEX:       0x01,       // no index signal detected
	SEEK_INCOMPLETE:0x02,       // no seek-complete signal
	WRITE_FAULT:    0x03,
	NOT_READY:      0x04,       // after the controller selected the drive, the drive did not respond with a ready signal
	NO_TRACK:       0x06,       // after stepping the max number of cylinders, the controller did not receive the track 00 signal from the drive
	STILL_SEEKING:  0x08,
	ECC_ID_ERROR:   0x10,
	ECC_DATA_ERROR: 0x11,
	NO_ADDR_MARK:   0x12,
	NO_SECTOR:      0x14,
	BAD_SEEK:       0x15,       // seek error: the cylinder and/or head address did not compare with the expected target address
	ECC_CORRECTABLE:0x18,       // correctable data error
	BAD_TRACK:      0x19,
	BAD_CMD:        0x20,
	BAD_DISK_ADDR:  0x21,
	RAM:            0x30,
	CHECKSUM:       0x31,
	POLYNOMIAL:     0x32,
	MASK:           0x3F
};

HDC.XTC.DATA.SENSE = {
    ADDR_VALID:     0x80
};

/*
 * HDC Command Sequences
 * 
 * Unlike the FDC, all the HDC commands have fixed-length command request sequences (well, OK, except for 
 * HDC.XTC.DATA.CMD.INIT_DRIVE) and fixed-length response sequences (well, OK, except for HDC.XTC.DATA.CMD.REQUEST_SENSE),
 * so a table of byte-lengths isn't much use, but having names for all the commands is still handy for debugging.
 */
if (DEBUG) {
    HDC.aATCCommands = {
        0x10: "Restore (Recalibrate)",
        0x20: "Read",
        0x30: "Write",
        0x40: "Read Verify",
        0x50: "Format Track",
        0x70: "Seek",
        0x90: "Diagnose",
        0x91: "Set Parameters"
    };
    HDC.aXTCCommands = {
        0x00: "Test Drive Ready",
        0x01: "Recalibrate",
        0x03: "Request Sense Status",
        0x04: "Format Drive",
        0x05: "Read Verify",
        0x06: "Format Track",
        0x07: "Format Bad Track",
        0x08: "Read",
        0x0A: "Write",
        0x0B: "Seek",
        0x0C: "Initialize Drive Characteristics",
        0x0D: "Read ECC Burst Error Length",
        0x0E: "Read Data from Sector Buffer",
        0x0F: "Write Data to Sector Buffer",
        0xE0: "RAM Diagnostic",
        0xE3: "Drive Diagnostic",
        0xE4: "Controller Diagnostic",
        0xE5: "Read Long",
        0xE6: "Write Long"
    };
}

/*
 * HDC BIOS interrupts, functions, and other parameters
 *
 * When the HDC BIOS overwrites the ROM BIOS INT 0x13 address, it saves the original INT 0x13 address
 * in the INT 0x40 vector.
 */
HDC.BIOS = {
    DISK_INT:       0x13,
    DISKETTE_INT:   0x40
};

HDC.BIOS.DISK_CMD = {
    RESET:          0x00,
    GET_STATUS:     0x01,
    READ_SECTORS:   0x02,
    WRITE_SECTORS:  0x03,
    VERIFY_SECTORS: 0x04,
    FORMAT_TRK:     0x05,
    FORMAT_BAD:     0x06,
    FORMAT_DRIVE:   0x07,
    GET_DRIVEPARMS: 0x08,
    SET_DRIVEPARMS: 0x09,
    READ_LONG:      0x0A,
    WRITE_LONG:     0x0B,
    SEEK:           0x0C,
    ALT_RESET:      0x0D,
    READ_BUFFER:    0x0E,
    WRITE_BUFFER:   0x0F,
    TEST_READY:     0x10,
    RECALIBRATE:    0x11,
    RAM_DIAGNOSTIC: 0x12,
    DRV_DIAGNOSTIC: 0x13,
    CTL_DIAGNOSTIC: 0x14
};

/**
 * setBinding(sHTMLClass, sHTMLType, sBinding, control)
 * 
 * @this {HDC}
 * @param {string|null} sHTMLClass is the class of the HTML control (eg, "input", "output")
 * @param {string|null} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
 * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "listDisks")
 * @param {Object} control is the HTML control DOM object (eg, HTMLButtonElement)
 * @return {boolean} true if binding was successful, false if unrecognized binding request
 */
HDC.prototype.setBinding = function(sHTMLClass, sHTMLType, sBinding, control)
{
    /*
     * This is reserved for future use; for now, hard disk images can be specified during initialization only (no "hot-swapping")
     */
    return false;
};

/**
 * initBus(cmp, bus, cpu, dbg)
 * 
 * @this {HDC}
 * @param {Computer} cmp
 * @param {Bus} bus
 * @param {X86CPU} cpu
 * @param {Debugger} dbg
 */
HDC.prototype.initBus = function(cmp, bus, cpu, dbg)
{
    this.bus = bus;
    this.cpu = cpu;
    this.dbg = dbg;
    this.cmp = cmp;

    /*
     * We need access to the ChipSet component, because we need to communicate with
     * the PIC and DMA controller.
     */
    this.chipset = cmp.getComponentByType("ChipSet");

    bus.addPortInputTable(this, this.fATC? HDC.aATCPortInput : HDC.aXTCPortInput);
    bus.addPortOutputTable(this, this.fATC? HDC.aATCPortOutput : HDC.aXTCPortOutput);
    
    if (DEBUGGER) {
        cpu.addInterruptNotify(HDC.BIOS.DISK_INT, this, this.intBIOSDisk);
        cpu.addInterruptNotify(HDC.BIOS.DISKETTE_INT, this, this.intBIOSDiskette);
    }
    
    /*
     * The following code used to be performed in the HDC constructor, but now we need to wait for information
     * about the Computer to be available (eg, getMachineID() and getUserID()) before we start loading and/or
     * connecting to disk images.
     * 
     * If we didn't need auto-mount support, we could defer controller initialization until we received a powerUp()
     * notification, at which point reset() would call initController(), or restore() would restore the controller;
     * in that case, all we'd need to do here is call setReady().
     */
    this.reset();

    if (!this.autoMount()) this.setReady();
};

/**
 * powerUp(data, fRepower)
 *
 * @this {HDC}
 * @param {Object|null} data
 * @param {boolean} [fRepower]
 * @return {boolean} true if successful, false if failure
 */
HDC.prototype.powerUp = function(data, fRepower)
{
    if (!fRepower) {
        if (!data || !this.restore) {
            this.initController();
            if (this.cmp.fReload) {
                /*
                 * If the computer's fReload flag is set, we're required to toss all currently
                 * loaded disks and remount all disks specified in the auto-mount configuration. 
                 */
                this.autoMount(true);
            }
        } else {
            if (!this.restore(data)) return false;
        }
    }
    return true;
};

/**
 * powerDown(fSave, fShutdown)
 * 
 * @this {HDC}
 * @param {boolean} fSave
 * @param {boolean} [fShutdown]
 * @return {Object|boolean}
 */
HDC.prototype.powerDown = function(fSave, fShutdown)
{
    return fSave && this.save? this.save() : true;
};

/**
 * getMachineID()
 * 
 * @return {string}
 */
HDC.prototype.getMachineID = function()
{
    return this.cmp? this.cmp.getMachineID() : "";
};

/**
 * getUserID()
 *
 * @return {string}
 */
HDC.prototype.getUserID = function()
{
    return this.cmp? this.cmp.getUserID() : "";
};

/**
 * reset()
 * 
 * @this {HDC}
 */
HDC.prototype.reset = function()
{
    /*
     * TODO: The controller is also initialized by the constructor, to assist with auto-mount support,
     * so think about whether we can skip powerUp initialization.
     */
    this.initController(null, true);
};

/**
 * save()
 * 
 * This implements save support for the HDC component.
 *
 * @this {HDC}
 * @return {Object}
 */
HDC.prototype.save = function()
{
    var state = new State(this);
    state.set(0, this.saveController());
    return state.data();
};

/**
 * restore(data)
 * 
 * This implements restore support for the HDC component.
 *
 * @this {HDC}
 * @param {Object} data
 * @return {boolean} true if successful, false if failure
 */
HDC.prototype.restore = function(data)
{
    return this.initController(data[0]);
};

/**
 * initController(data, fReset)
 * 
 * @this {HDC}
 * @param {Array} [data]
 * @param {boolean} [fReset] true if a machine reset (not just a controller reset)
 * @return {boolean} true if successful, false if failure
 */
HDC.prototype.initController = function(data, fReset)
{
    var i = 0;
    var fSuccess = true;
    
    /*
     * At this point, it's worth calling into question my decision to NOT split the HDC component into separate XTC
     * and ATC components, given all the differences, and given that I'm about to write some "if (ATC) else (XTC) ..."
     * code.  And all I can say in my defense is, yes, it's definitely worth calling that into question.
     * 
     * However, there's also some common code, mostly in the area of disk management rather than controller management,
     * and if the components were split, then I'd have to create a third component for that common code (although again,
     * disk management probably belongs in its own component anyway).
     * 
     * However, let's not forget that since my overall plan is to have only one PCjs "binary", everything's going to end
     * up in the same bucket anyway, so let's not be too obsessive about organizational details.  As long as the number
     * of these conditionals is small and they're not performance-critical, this seems much ado about nothing.
     */
    if (this.fATC) {
        /*
         * Since there's no way (and never will be a way) for an HDC to change its "personality" (from 'xt' to 'at'
         * or vice versa), we're under no obligation to use the same number of registers, or save/restore format, etc,
         * as the original XT controller.
         */
        if (data == null) data = [0, 0, 0, 0, 0, 0, 0, 0, HDC.ATC.STATUS.READY, 0];
        this.regError   = data[i++];
        this.regWPreC   = data[i++];
        this.regSecCnt  = data[i++];
        this.regSecNum  = data[i++];
        this.regCylLo   = data[i++];
        this.regCylHi   = data[i++];
        this.regDrvHd   = data[i++];
        this.regStatus  = data[i++];
        this.regCommand = data[i++];
        /*
         * Additional state is maintained by the Drive object (eg, abSector, ibSector)
         */
    } else {
        if (data == null) data = [0, HDC.XTC.STATUS.NONE, new Array(14), 0, 0];
        this.regConfig    = data[i++];
        this.regStatus    = data[i++];
        this.regDataArray = data[i++];  // there can be up to 14 command bytes (6 for normal commands, plus 8 more for HDC.XTC.DATA.CMD.INIT_DRIVE)
        this.regDataIndex = data[i++];  // used to control the next data byte to be received
        this.regDataTotal = data[i++];  // used to control the next data byte to be sent (internally, we use regDataIndex to read data bytes, up to this total)
        this.regReset     = data[i++];
        this.regPulse     = data[i++];
        this.regPattern   = data[i++];
        /*
         * Initialize iDriveAllowFail only if it's never been initialized, otherwise its entire purpose will be defeated.
         * See the related HACK in intBIOSDisk() for more details.
         */
        var iDriveAllowFail = data[i++];
        if (iDriveAllowFail !== undefined) {
            this.iDriveAllowFail = iDriveAllowFail;
        } else {
            if (this.iDriveAllowFail === undefined) this.iDriveAllowFail = -1;
        }
    }

    if (this.aDrives === undefined) {
        this.aDrives = new Array(this.aDriveConfigs.length);
    }

    var dataDrives = data[i];
    if (dataDrives === undefined) dataDrives = [];

    for (var iDrive = 0; iDrive < this.aDrives.length; iDrive++) {
        if (this.aDrives[iDrive] === undefined) {
            this.aDrives[iDrive] = {};
        }
        var drive = this.aDrives[iDrive];
        var driveConfig = this.aDriveConfigs[iDrive];
        if (!this.initDrive(iDrive, drive, driveConfig, dataDrives[iDrive], fReset)) {
            fSuccess = false;
        }
        /*
         * XTC only: the original STC-506/412 controller had two pairs of DIP switches to indicate a drive
         * type (0, 1, 2 or 3) for drives 0 and 1.  Those switch settings are recorded in regConfig, now that
         * drive.type has been validated by initDrive().
         */
        if (this.regConfig != null && iDrive <= 1) {
            this.regConfig |= (drive.type & 0x3) << ((1 - iDrive) << 1);
        }
    }
    if (DEBUG) this.messageDebugger("HDC initialized for " + this.aDrives.length + " drive(s)");
    return fSuccess;
};

/**
 * saveController()
 * 
 * @this {HDC}
 * @return {Array}
 */
HDC.prototype.saveController = function()
{
    var i = 0;
    var data = [];
    if (this.fATC) {
        data[i++] = this.regError;
        data[i++] = this.regWPreC;
        data[i++] = this.regSecCnt;
        data[i++] = this.regSecNum;
        data[i++] = this.regCylLo;
        data[i++] = this.regCylHi;
        data[i++] = this.regDrvHd;
        data[i++] = this.regStatus;
        data[i++] = this.regCommand;
    } else {
        data[i++] = this.regConfig;
        data[i++] = this.regStatus;
        data[i++] = this.regDataArray;
        data[i++] = this.regDataIndex;
        data[i++] = this.regDataTotal;
        data[i++] = this.regReset;
        data[i++] = this.regPulse;
        data[i++] = this.regPattern;
        data[i++] = this.iDriveAllowFail;
    }
    data[i] = this.saveDrives();
    return data;
};

/**
 * initDrive(iDrive, drive, driveConfig, data, fReset)
 * 
 * @this {HDC}
 * @param {number} iDrive
 * @param {Object} drive
 * @param {Object} driveConfig (contains one or more of the following properties: 'name', 'path', 'size', 'type')
 * @param {Array} [data]
 * @param {boolean} [fReset] true if a machine reset (not just a controller reset)
 * @return {boolean} true if successful, false if failure
 */
HDC.prototype.initDrive = function(iDrive, drive, driveConfig, data, fReset)
{
    var i = 0;
    var fSuccess = true;
    if (data === undefined) data = [HDC.XTC.DATA.ERR.NONE, 0, false, new Array(8)];

    drive.iDrive = iDrive;

    /*
     * errorCode could be an HDC global, but in order to insulate HDC state from the operation of various functions
     * that operate on drive objects (eg, readByte and writeByte), I've made it a per-drive variable.  This choice may
     * be contrary to how the actual hardware works, but I prefer this approach, as long as it doesn't expose any
     * incompatibilities that any software actually cares about.
     */
    drive.errorCode = data[i++];
    drive.senseCode = data[i++];
    drive.fRemovable = data[i++];
    drive.abDriveParms = data[i++];         // captures drive parameters programmed via HDC.XTC.DATA.CMD.INIT_DRIVE
    
    /*
     * TODO: Make abSector a DWORD array rather than a BYTE array (we could even allocate a Memory block for it);
     * alternatively, eliminate the buffer entirely and re-establish a reference to the appropriate Disk sector object. 
     */
    drive.abSector = data[i++];

    /*
     * The next group of properties are set by various HDC command sequences.
     */
    drive.bHead = data[i++];
    drive.nHeads = data[i++];
    drive.wCylinder = data[i++];
    drive.bSector = data[i++];
    drive.bSectorEnd = data[i++];           // aka EOT
    drive.nBytes = data[i++];
    drive.bSectorBias = (this.fATC? 0: 1);

    drive.name = driveConfig['name'];
    if (drive.name === undefined) drive.name = HDC.DEFAULT_DRIVE_NAME;
    drive.path = driveConfig['path'];

    /*
     * If no 'mode' is specified, we fall back to the original behavior, which is to completely preload
     * any specific disk image, or create an empty (purely local) disk image.
     */
    drive.mode = driveConfig['mode'] || (drive.path? DiskAPI.MODE.PRELOAD : DiskAPI.MODE.LOCAL);
    
    /*
     * On-demand I/O of raw disk images is supported only if there's a valid user ID; fall back to an empty
     * local disk image if there's not.
     */
    if (drive.mode == DiskAPI.MODE.DEMANDRO || drive.mode == DiskAPI.MODE.DEMANDRW) {
        if (!this.getUserID()) drive.mode = DiskAPI.MODE.LOCAL;
    }

    drive.type = driveConfig['type'];
    if (drive.type === undefined || HDC.aDriveTypes[this.iHDC][drive.type] === undefined) drive.type = this.iDriveTypeDefault;
    
    var driveType = HDC.aDriveTypes[this.iHDC][drive.type];
    drive.nSectors = driveType[2] || 17;    // sectors/track
    drive.cbSector = driveType[3] || 512;   // bytes/sector (default is 512 if unspecified in the table)

    /*
     * On a full machine reset, pass the current drive type to setCMOSDriveType() (a no-op on pre-CMOS machines)
     */
    if (fReset && this.chipset) {
        this.chipset.setCMOSDriveType(iDrive, drive.type);
    }
    
    /*
     * The next group of properties are set by user requests to load/unload disk images.
     * 
     * NOTE: I now avoid reinitializing drive.disk in order to retain any previously mounted disk across resets.
     */
    if (drive.disk === undefined) {
        drive.disk = null;
        this.notice("Type " + drive.type + " \"" + drive.name + "\" is fixed disk " + iDrive, true);
    }

    /*
     * With the advent of save/restore, we need to verify every drive at initialization, not just whenever
     * drive characteristics are initialized.  Thus, if we've restored a sensible set of drive characteristics,
     * then verifyDrive will create an empty disk if none has been provided, insuring we are ready for
     * disk.restore().
     */
    this.verifyDrive(drive);

    /*
     * The next group of properties are managed by worker functions (eg, doRead()) to maintain state across DMA requests.
     */
    drive.ibSector = data[i++];             // location of the next byte to be accessed in the above sector
    drive.sector = null;                    // initialized to null by worker, and then set to the next sector satisfying the request

    if (drive.disk) {
        var deltas = data[i];
        if (deltas !== undefined && drive.disk.restore(deltas) < 0) {
            fSuccess = false;
        }
        if (fSuccess && drive.ibSector !== undefined) {
            drive.sector = drive.disk.seek(drive.wCylinder, drive.bHead, drive.bSector + drive.bSectorBias);
        }
    }
    return fSuccess;
};

/**
 * saveDrives()
 * 
 * @this {HDC}
 * @return {Array}
 */
HDC.prototype.saveDrives = function()
{
    var i = 0;
    var data = [];
    for (var iDrive = 0; iDrive < this.aDrives.length; iDrive++) {
        data[i++] = this.saveDrive(this.aDrives[iDrive]);
    }
    return data;
};

/**
 * saveDrive(drive)
 * 
 * @this {HDC}
 * @return {Array}
 */
HDC.prototype.saveDrive = function(drive)
{
    var i = 0;
    var data = [];
    data[i++] = drive.errorCode;
    data[i++] = drive.senseCode;
    data[i++] = drive.fRemovable;
    data[i++] = drive.abDriveParms;
    data[i++] = drive.abSector;
    data[i++] = drive.bHead;
    data[i++] = drive.nHeads;
    data[i++] = drive.wCylinder;
    data[i++] = drive.bSector;
    data[i++] = drive.bSectorEnd;
    data[i++] = drive.nBytes;
    data[i++] = drive.ibSector;
    data[i] = drive.disk? drive.disk.save() : null;
    return data;
};

/**
 * copyDrive(iDrive)
 * 
 * @this {HDC}
 * @param {number} iDrive
 * @return {Object|undefined} (undefined if the requested drive does not exist)
 */
HDC.prototype.copyDrive = function(iDrive)
{
    var driveNew;
    var driveOld = this.aDrives[iDrive];
    if (driveOld !== undefined) {
        driveNew = {};
        for (var p in driveOld) {
            driveNew[p] = driveOld[p];
        }
    }
    return driveNew;
};

/**
 * verifyDrive(drive, type)
 *
 * If no disk image is attached, create an empty disk with the specified drive characteristics.
 * Normally, we'd rely on the drive characteristics programmed via the HDC.XTC.DATA.CMD.INIT_DRIVE
 * command, but if an explicit drive type is specified, then we use the characteristics (geometry)
 * associated with that type.
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {number} [type] to create a disk of the specified type, if no disk exists yet
 */
HDC.prototype.verifyDrive = function(drive, type)
{
    if (drive) {
        var nHeads = 0, nCylinders = 0;
        if (type == null) {
            /*
             * If the caller wants us to use the programmed drive parameters, we use those,
             * but if there aren't any drive parameters (yet), then use default parameters based
             * on drive.type.
             * 
             * We used to do the last step ONLY if there was no drive.path -- otherwise, we'd waste
             * time creating an empty disk if autoMount() was going to load an image from drive.path;
             * but hopefully the Disk component is smarter now.
             */
            nHeads = drive.abDriveParms[2];
            if (nHeads) {
                nCylinders = (drive.abDriveParms[0] << 8) | drive.abDriveParms[1];
            } else {
                type = drive.type;
            }
        }
        if (type != null && !nHeads) {
            nHeads = HDC.aDriveTypes[this.iHDC][type][1];
            nCylinders = HDC.aDriveTypes[this.iHDC][type][0];
        }
        if (nHeads) {
            /*
             * The assumption here is that if the 3rd drive parameter byte (abDriveParms[2]) has been set
             * (ie, if nHeads is valid) then the first two bytes (ie, the low and high cylinder byte values)
             * must have been set as well.
             *
             * Do these values agree with those for the given drive type?  Even if they don't, all we do is warn.
             */
            var driveType = HDC.aDriveTypes[this.iHDC][drive.type];
            if (driveType) {
                if (nCylinders != driveType[0] && nHeads != driveType[1]) {
                    this.notice("Warning: drive parameters (" + nCylinders + "," + nHeads + ") do not match drive type " + drive.type + " (" + driveType[0] + "," + driveType[1] + ")");
                }
            }
            drive.nCylinders = nCylinders;
            drive.nHeads = nHeads;
            if (drive.disk == null) {
                drive.disk = new Disk(this, drive, drive.mode);
            }
        }
    }
};

/**
 * seekDrive(drive, iSector, nSectors)
 *
 * The HDC doesn't need this function, since all HDC requests from the CPU are handled by doXTCmd().  This function
 * is used by other components (eg, Debugger) to mimic an HDC request, using a drive object obtained from copyDrive(),
 * to avoid disturbing the internal state of the HDC's drive objects.
 *
 * Also note that in an actual HDC request, drive.nBytes is initialized to the size of a single sector; the extent
 * of the entire transfer is actually determined by a count that has been pre-loaded into the DMA controller.  The HDC
 * isn't aware of the extent of the transfer, so in the case of a read request, all readByte() can do is return bytes
 * until the current track (or, in the case of a multi-track request, the current cylinder) has been exhausted.
 *
 * Since seekDrive() is for use with non-DMA requests, we use nBytes to specify the length of the entire transfer.
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {number} iSector (a "logical" sector number, relative to the entire disk, NOT a physical sector number)
 * @param {number} nSectors
 * @return {boolean} true if successful, false if invalid position request
 */
HDC.prototype.seekDrive = function(drive, iSector, nSectors)
{
    if (drive.disk) {
        var aDiskInfo = drive.disk.info();
        var nCylinders = aDiskInfo[0];
        /*
         * If nCylinders is zero, we probably have an empty disk image, awaiting initialization (see verifyDrive()) 
         */
        if (nCylinders) {
            var nHeads = aDiskInfo[1];
            var nSectorsPerTrack = aDiskInfo[2];
            var nSectorsPerCylinder = nHeads * nSectorsPerTrack;
            var nSectorsPerDisk = nCylinders * nSectorsPerCylinder;
            if (iSector + nSectors <= nSectorsPerDisk) {
                drive.wCylinder = Math.floor(iSector / nSectorsPerCylinder);
                iSector %= nSectorsPerCylinder;
                drive.bHead = Math.floor(iSector / nSectorsPerTrack);
                /*
                 * Important difference between the FDC and the XTC: the XTC uses 0-based sector numbers, so unlike
                 * FDC.seekDrive(), we must NOT add 1 to bSector below.  I could change how sector numbers are stored in
                 * hard disk images, but it seems preferable to keep the image format consistent and controller-independent.
                 */
                drive.bSector = (iSector % nSectorsPerTrack);
                drive.nBytes = nSectors * aDiskInfo[3];
                /*
                 * NOTE: We don't set nSectorEnd, as an HDC command would, but it's irrelevant, because we don't actually
                 * do anything with nSectorEnd at this point.  Perhaps someday, when we faithfully honor/restrict requests
                 * to a single track (or a single cylinder, in the case of multi-track requests). 
                 */
                drive.errorCode = HDC.XTC.DATA.ERR.NONE;
                /*
                 * At this point, we've finished simulating what an HDC.XTC.DATA.CMD.READ_DATA command would have performed,
                 * up through doRead().  Now it's the caller responsibility to call readByte(), like the DMA Controller would.
                 */
                return true;
            }
        }
    }
    return false;
};

/**
 * autoMount(fRemount)
 * 
 * @this {HDC}
 * @param {boolean} [fRemount] is true if we're remounting all auto-mounted disks
 * @return {boolean} true if one or more disk images are being auto-mounted, false if none
 */
HDC.prototype.autoMount = function(fRemount)
{
    if (!fRemount) this.cAutoMount = 0;
    for (var iDrive = 0; iDrive < this.aDrives.length; iDrive++) {
        var drive = this.aDrives[iDrive];
        if (drive.name && drive.path) {
            if (!this.loadDisk(iDrive, drive.name, drive.path, true) && fRemount)
                this.setReady(false);
            continue;
        }
        if (fRemount && drive.type !== undefined) {
            drive.disk = null;
            this.verifyDrive(drive, drive.type);
        }
    }
    return !!this.cAutoMount;
};

/**
 * loadDisk(iDrive, sDiskName, sDiskPath, fAutoMount)
 * 
 * @this {HDC}
 * @param {number} iDrive
 * @param {string} sDiskName
 * @param {string} sDiskPath
 * @param {boolean} fAutoMount
 * @return {boolean} true if disk (already) loaded, false if queued up (or busy)
 */
HDC.prototype.loadDisk = function(iDrive, sDiskName, sDiskPath, fAutoMount)
{
    var drive = this.aDrives[iDrive];
    if (drive.fBusy) {
        this.notice("Drive " + iDrive + " busy");
        return true;
    }
    drive.fBusy = true;
    if (fAutoMount) {
        drive.fAutoMount = true;
        this.cAutoMount++;
        this.messageDebugger("loading " + sDiskName);
    }
    var disk = drive.disk || new Disk(this, drive, drive.mode);
    disk.load(sDiskName, sDiskPath, this.mountDisk);
    return false;
};

/**
 * mountDisk(drive, disk, sDiskName, sDiskPath)
 * 
 * This is a callback issued by the Disk component once its own mount() operation has finished.
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {Disk} disk is set if the disk was successfully mounted, null if not
 * @param {string} sDiskName
 * @param {string} sDiskPath
 */
HDC.prototype.mountDisk = function(drive, disk, sDiskName, sDiskPath)
{
    drive.fBusy = false;
    if ((drive.disk = disk)) {
        /*
         * With the addition of notify(), users are now "alerted" whenever a diskette has finished loading;
         * notify() is selective about its output, using print() if a print window is open, otherwise alert().
         *
         * WARNING: This conversion of drive number to drive letter, starting with "C:" (0x43), is very simplistic
         * and is not guaranteed to match the drive mapping that DOS ultimately uses.
         */
        this.notice("Mounted disk \"" + sDiskName + "\" in drive " + String.fromCharCode(0x43 + drive.iDrive), drive.fAutoMount);
    }
    if (drive.fAutoMount) {
        drive.fAutoMount = false;
        if (!--this.cAutoMount) this.setReady();
    }
};

/**
 * unloadDrive(iDrive)
 *
 * NOTE: At the moment, we support only auto-mounts; there is no user interface for selecting hard disk images,
 * let alone unloading them, so there is currently no need for the following function.
 * 
 * @this {HDC}
 * @param {number} iDrive
 *
 HDC.prototype.unloadDrive = function(iDrive)
 {
    this.aDrives[iDrive].disk = null;
    //
    // WARNING: This conversion of drive number to drive letter, starting with "C:" (0x43), is very simplistic
    // and is not guaranteed to match the drive mapping that DOS ultimately uses.
    //
    this.notice("Drive " + String.fromCharCode(0x43 + iDrive) + " unloaded");
};
 */

/**
 * intXTCData(port, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x320)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inXTCData = function(port, addrFrom)
{
    var bIn = 0;
    if (this.regDataIndex < this.regDataTotal) {
        bIn = this.regDataArray[this.regDataIndex];
    }
    if (this.chipset) this.chipset.clearIRR(ChipSet.IRQ.XTC);
    this.regStatus &= ~HDC.XTC.STATUS.INTERRUPT;

    this.messagePort(port, null, addrFrom, "DATA[" + this.regDataIndex + "]", bIn);
    if (++this.regDataIndex >= this.regDataTotal) {
        this.regDataIndex = this.regDataTotal = 0;
        this.regStatus &= ~(HDC.XTC.STATUS.IOMODE | HDC.XTC.STATUS.BUS | HDC.XTC.STATUS.BUSY);
    }
    return bIn;
};

/**
 * outXTCData(port, bOut, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x320)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outXTCData = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "DATA[" + this.regDataTotal + "]");
    if (this.regDataTotal < this.regDataArray.length) {
        this.regDataArray[this.regDataTotal++] = bOut;
    }
    var bCmd = this.regDataArray[0];
    var cbCmd = (bCmd != HDC.XTC.DATA.CMD.INIT_DRIVE? 6 : this.regDataArray.length);
    if (this.regDataTotal == 6) {
        /*
         * XTC.STATUS.REQ must be CLEAR following any 6-byte command sequence that the HDC BIOS "COMMAND" function outputs,
         * yet it must also be SET before the HDC BIOS will proceed with the remaining the 8-byte sequence that's part of
         * HDC.XTC.DATA.CMD.INIT_DRIVE command. See inXTCStatus() for HACK details.
         */
        this.regStatus &= ~HDC.XTC.STATUS.REQ;
    }
    if (this.regDataTotal >= cbCmd) {
        /*
         * It's essential that XTC.STATUS.IOMODE be set here, at least after the final 8-byte HDC.XTC.DATA.CMD.INIT_DRIVE sequence.  
         */
        this.regStatus |= HDC.XTC.STATUS.IOMODE;
        this.regStatus &= ~HDC.XTC.STATUS.REQ;
        this.doXTCommand();
    }
};

/**
 * inXTCStatus(port, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x321)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inXTCStatus = function(port, addrFrom)
{
    var b = this.regStatus;
    this.messagePort(port, null, addrFrom, "STATUS", b);
    /*
     * HACK: The HDC BIOS will not finish the HDC.XTC.DATA.CMD.INIT_DRIVE sequence unless it sees XTC.STATUS.REQ set again, nor will
     * it read any of the XTC.DATA bytes returned from a HDC.XTC.DATA.CMD.REQUEST_SENSE command unless XTC.STATUS.REQ is set again, so
     * we turn it back on if there are unprocessed data bytes.
     */
    if (this.regDataIndex < this.regDataTotal) {
        this.regStatus |= HDC.XTC.STATUS.REQ;
    }
    return b;
};

/**
 * outXTCReset(port, bOut, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x321)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outXTCReset = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "RESET");
    /*
     * Not sure what to do with this value, and the value itself may be "don't care", but we'll save it anyway. 
     */
    this.regReset = bOut;
    if (this.chipset) this.chipset.clearIRR(ChipSet.IRQ.XTC);
    this.initController();
};

/**
 * inXTCConfig(port, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x322)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inXTCConfig = function(port, addrFrom)
{
    this.messagePort(port, null, addrFrom, "CONFIG", this.regConfig);
    return this.regConfig;
};

/**
 * outXTCPulse(port, bOut, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x322)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outXTCPulse = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "PULSE");
    /*
     * Not sure what to do with this value, and the value itself may be "don't care", but we'll save it anyway. 
     */
    this.regPulse = bOut;
    /*
     * The HDC BIOS "COMMAND" function (@C800:0562) waits for these ALL status bits after writing to both regPulse
     * and regPattern, so we must oblige it.
     *
     * TODO: Figure out exactly when either XTC.STATUS.BUS or XTC.STATUS.BUSY are supposed to be cleared.
     * The HDC BIOS doesn't care much about them, except for the one location mentioned above. However, MS-DOS 4.0
     * (aka the unreleased "multitasking" version of MS-DOS) cares, so I'm going to start by clearing them at the
     * same point I clear XTC.STATUS.IOMODE.
     */
    this.regStatus = HDC.XTC.STATUS.REQ | HDC.XTC.STATUS.BUS | HDC.XTC.STATUS.BUSY;
};

/**
 * outXTCPattern(port, bOut, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x323)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outXTCPattern = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "PATTERN");
    this.regPattern = bOut;
};

/**
 * outXTCNoise(port, bOut, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x327, 0x32B or 0x32F)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outXTCNoise = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "NOISE");
};

/**
 * inATCData(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F0)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCData = function(port, addrFrom)
{
    var bIn = -1;
    var fSuppress = false;
    
    if (this.drive) {
        /*
         * messagePort() calls, if enabled, can be too overwhelming for this port, so limit them to the first byte. 
         */
        fSuppress = (this.drive.ibSector > 0);
        
        /*
         * We use the synchronous form of readByte() at this point because we have no choice; an I/O instruction
         * has just occurred and cannot be delayed.  The good news is that doATCommand() should have already primed
         * the pump; all we can do is assert that the pump has something in it.  If bIn is inexplicably negative,
         * well, then the caller will get 0xff.
         */
        bIn = this.readByte(this.drive);
        Component.assert(bIn >= 0);
        
        /*
         * Now that we've supplied a full sector of data, see if the caller's expecting additional sectors;
         * if so, prime the pump again.  The caller should not poll us again until another interrupt's been delivered.
         */
        if (this.drive.ibSector == this.drive.cbSector) {
            this.drive.nBytes -= this.drive.cbSector;
            /*
             * TODO: If the WITH_ECC bit is set in the READ_DATA command, then we need to support "stuffing" 4
             * additional bytes into the inATCData() stream.  And we must first set DATA_REQ in the STATUS register.
             */
            if (this.drive.nBytes >= this.drive.cbSector) {
                var hdc = this;
                this.readByte(this.drive, function(b, fAsync) {
                    if (b >= 0) {
                        if (hdc.chipset) hdc.chipset.setIRR(ChipSet.IRQ.ATC);
                        /*
                         * I shouldn't have to set BUSY again, because it should still be set, no?
                         */
                        Component.assert(!!(hdc.regStatus & HDC.ATC.STATUS.BUSY));
                    } else {
                        /*
                         * TODO: It would be nice to be a bit more specific about the error (if any) that just occurred.
                         * Consult drive.errorCode (it uses older XTC error codes, but mapping those codes should be trivial).
                         */ 
                         hdc.regStatus = HDC.ATC.STATUS.ERROR;
                         hdc.regError = HDC.ATC.ERROR.NO_CHS;
                        if (DEBUG) hdc.messageDebugger("HDC.inATCData(): read failed");
                    }
                }, false);
            } else {
                Component.assert(this.drive.nBytes == 0);
                this.regStatus = HDC.ATC.STATUS.READY | HDC.ATC.STATUS.SEEK_OK;
            }
        }
    }
    if (!fSuppress) this.messagePort(port, null, addrFrom, "DATA", bIn);
    return bIn;
};

/**
 * outATCData(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F0)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCData = function(port, bOut, addrFrom)
{
    /*
     * messagePort() calls, if enabled, can be too overwhelming for this port, so limit them to the first byte. 
     */
    if (!this.drive || this.drive.ibSector == 0) this.messagePort(port, bOut, addrFrom, "DATA");
    
    if (this.drive) {
        if (this.drive.nBytes >= this.drive.cbSector) {
            if (this.writeByte(this.drive, bOut) < 0) {
                /*
                 * TODO: It would be nice to be a bit more specific about the error (if any) that just occurred.
                 * Consult drive.errorCode (it uses older XTC error codes, but mapping those codes should be trivial).
                 */
                this.regStatus = HDC.ATC.STATUS.ERROR;
                this.regError = HDC.ATC.ERROR.NO_CHS;
                if (DEBUG) this.messageDebugger("HDC.outATCData(" + str.toHexByte(bOut) + "): write failed");
            }
            else if (this.drive.ibSector == this.drive.cbSector) {
                this.drive.nBytes -= this.drive.cbSector;
                if (this.chipset) this.chipset.setIRR(ChipSet.IRQ.ATC);
                if (this.drive.nBytes >= this.drive.cbSector) {
                    /*
                     * I shouldn't have to set BUSY again, because it should still be set, no?
                     */
                    Component.assert(!!(this.regStatus & HDC.ATC.STATUS.BUSY));
                } else {
                    Component.assert(this.drive.nBytes == 0);
                    this.regStatus = HDC.ATC.STATUS.READY | HDC.ATC.STATUS.SEEK_OK;
                }
            }
        } else {
            /*
             * TODO: What to do about unexpected writes? The number of bytes has exceeded what the command specified.
             */
            if (DEBUG) this.messageDebugger("HDC.outATCData(" + str.toHexByte(bOut) + "): write exceeds count (" + this.drive.nBytes + ")");
        }
    } else {
        /*
         * TODO: What to do about unexpected writes? The number of bytes has exceeded what the command specified.
         */
        if (DEBUG) this.messageDebugger("HDC.outATCData(" + str.toHexByte(bOut) + "): write without command");
    }
};

/**
 * inATCError(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F1)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCError = function(port, addrFrom)
{
    var bIn = this.regError;
    this.messagePort(port, null, addrFrom, "ERROR", bIn);
    return bIn;
};

/**
 * outATCWPreC(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F1)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCWPreC = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "WPREC");
    this.regWPreC = bOut;
};

/**
 * inATCSecCnt(port, addrFrom)
 * 
 * @this {HDC}
 * @param {number} port (0x1F2)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCSecCnt = function(port, addrFrom)
{
    var bIn = this.regSecCnt;
    this.messagePort(port, null, addrFrom, "SECCNT", bIn);
    return bIn;
};

/**
 * outATCSecCnt(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F2)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCSecCnt = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "SECCNT");
    this.regSecCnt = bOut;
};

/**
 * inATCSecNum(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F3)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCSecNum = function(port, addrFrom)
{
    var bIn = this.regSecNum;
    this.messagePort(port, null, addrFrom, "SECNUM", bIn);
    return bIn;
};

/**
 * outATCSecNum(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F3)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCSecNum = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "SECNUM");
    this.regSecNum = bOut;
};

/**
 * inATCCylLo(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F4)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCCylLo = function(port, addrFrom)
{
    var bIn = this.regCylLo;
    this.messagePort(port, null, addrFrom, "CYLLO", bIn);
    return bIn;
};

/**
 * outATCCylLo(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F4)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCCylLo = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "CYLLO");
    this.regCylLo = bOut;
};

/**
 * inATCCylHi(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F5)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCCylHi = function(port, addrFrom)
{
    var bIn = this.regCylHi;
    this.messagePort(port, null, addrFrom, "CYLHI", bIn);
    return bIn;
};

/**
 * outATCCylHi(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F5)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCCylHi = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "CYLHI");
    this.regCylHi = bOut;
};

/**
 * inATCDrvHd(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F6)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCDrvHd = function(port, addrFrom)
{
    var bIn = this.regDrvHd;
    this.messagePort(port, null, addrFrom, "DRVHD", bIn);
    return bIn;
};

/**
 * outATCDrvHd(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F6)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCDrvHd = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "DRVHD");
    this.regDrvHd = bOut;
};

/**
 * inATCStatus(port, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F7)
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to read the specified port)
 * @return {number} simulated port value
 */
HDC.prototype.inATCStatus = function(port, addrFrom)
{
    var bIn = this.regStatus;
    this.messagePort(port, null, addrFrom, "STATUS", bIn);
    return bIn;
};

/**
 * outATCCommand(port, bOut, addrFrom)
 *
 * @this {HDC}
 * @param {number} port (0x1F7)
 * @param {number} bOut
 * @param {number} [addrFrom] (not defined whenever the Debugger tries to write the specified port)
 */
HDC.prototype.outATCCommand = function(port, bOut, addrFrom)
{
    this.messagePort(port, bOut, addrFrom, "COMMAND");
    this.regCommand = bOut;
    if (this.chipset) this.chipset.clearIRR(ChipSet.IRQ.ATC);
    this.doATCommand();
};

/**
 * doATCommand()
 *
 * Handles ATC (AT Controller) commands
 *
 * @this {HDC}
 */
HDC.prototype.doATCommand = function()
{
    var hdc = this;
    var fInterrupt = false;
    var bCmd = this.regCommand;
    var iDrive = (this.regDrvHd & HDC.ATC.DRVHD.DRIVE_MASK? 1 : 0);
    var nHead = this.regDrvHd & HDC.ATC.DRVHD.HEAD_MASK;
    var nCylinder = this.regCylLo | ((this.regCylHi & HDC.ATC.CYLHI.MASK) << 8);
    var nSector = this.regSecNum;
    var nSectors = this.regSecCnt;
    
    this.drive = null;
    this.regError = 0;
    this.regStatus = HDC.ATC.STATUS.READY | HDC.ATC.STATUS.SEEK_OK;

    var drive = this.aDrives[iDrive];
    if (!drive) {
        bCmd = -1;
    } else {
        /*
         * Update the Drive object with the new positional information associated with this command.
         */
        drive.wCylinder = nCylinder;
        drive.bHead = nHead;
        drive.bSector = nSector;
        drive.nBytes = nSectors * drive.cbSector;
        bCmd = (bCmd >= HDC.ATC.COMMAND.DIAGNOSE? bCmd : (bCmd & HDC.ATC.COMMAND.MASK));
        /*
         * Since the ATC doesn't use DMA, we must now set some additional Drive state for the benefit of any
         * follow-up I/O instructions.  For example, any subsequent inATCData() and outATCData() calls need to
         * know which drive to talk to ("this.drive"), to issue their own readByte() and writeByte() calls.
         * 
         * The XTC didn't need this, because it used doRead(), doWrite(), doFormat() helper functions, which
         * reset the current drive's "sector" and "errorCode" properties themselves and then used DMA functions
         * that delivered drive data with direct calls to readByte() and writeByte().
         */
        drive.sector = null;
        drive.errorCode = 0;
        this.drive = drive;
    }

    if (DEBUG && DEBUGGER && this.dbg && this.dbg.messageEnabled(this.dbg.MESSAGE_PORT | this.dbg.MESSAGE_HDC)) {
        this.dbg.message("HDC.doATCommand(" + str.toHexByte(bCmd) + "): " + HDC.aATCCommands[bCmd]);
    }
    
    switch (bCmd & HDC.ATC.COMMAND.MASK) {
    
    case HDC.ATC.COMMAND.READ_DATA:
        /*
         * We're using a call to readByte() that disables auto-increment, so that once we've got the first
         * byte of the next sector, we can signal an interrupt without also consuming the first byte, allowing
         * inATCData() to begin with that byte.
         */
        this.readByte(drive, function(b, fAsync) {
            if (b >= 0 && hdc.chipset) {
                hdc.chipset.setIRR(ChipSet.IRQ.ATC);
                /*
                 * As with the WRITE_DATA command, I'm not sure which of BUSY and DATA_REQ (or both)
                 * should be set here, so I'm setting both of them for now.
                 */
                hdc.regStatus = HDC.ATC.STATUS.BUSY | HDC.ATC.STATUS.DATA_REQ;
            } else {
                /*
                 * TODO: It would be nice to be a bit more specific about the error (if any) that just occurred.
                 * Consult drive.errorCode (it uses older XTC error codes, but mapping those codes should be trivial).
                 */
                hdc.regStatus = HDC.ATC.STATUS.ERROR;
                hdc.regError = HDC.ATC.ERROR.NO_CHS;
            }
        }, false);
        break;

    case HDC.ATC.COMMAND.WRITE_DATA:
        if (hdc.chipset) {
            hdc.chipset.setIRR(ChipSet.IRQ.ATC);
            /*
             * I know that DATA_REQ must be set at this point, but I'm not sure about BUSY; so I'm
             * setting both of them for now.
             */
            hdc.regStatus = HDC.ATC.STATUS.BUSY | HDC.ATC.STATUS.DATA_REQ;
        } else {
            hdc.regStatus = HDC.ATC.STATUS.ERROR;
            hdc.regError = HDC.ATC.ERROR.CMD_ABORT;
        }
        break;

    case HDC.ATC.COMMAND.RESTORE:
        /*
         * Physically, this retracts the heads to cylinder 0, but logically, there isn't anything to do.
         */
        fInterrupt = true;
        break;

    case HDC.ATC.COMMAND.READ_VERF:
        /*
         * Since the READ VERIFY command returns no data, once again, logically, there isn't much for us to do.
         */
        fInterrupt = true;
        break;

    case HDC.ATC.COMMAND.DIAGNOSE:
        this.regError = HDC.ATC.DIAG.NO_ERROR;
        fInterrupt = true;
        break;
        
    case HDC.ATC.COMMAND.SETPARMS:
        /*
         * The documentation implies that the only parameters this command really affects are the number
         * of heads (from regDrvHd) and sectors/track (from regSecCnt) -- this despite the fact that the BIOS
         * programs all the other registers.  For a type 2 drive, that includes:
         *
         *      WPREC:   0x4B
         *      SECCNT:  0x11 (for 17 sectors per track)
         *      CYL:    0x100 (256, uh, what?)
         *      SECNUM:  0x0C (12, uh, what?)
         *      DRVHD:   0xA3 (max head of 0x03, for 4 total heads)
         * 
         * The importance of SECCNT (nSectors) and DRVHD (nHeads) is controlling how multi-sector operations
         * advance to the next sector; see advanceSector().
         */
        Component.assert(drive.nHeads == nHead + 1);
        Component.assert(drive.nSectors == nSectors);
        drive.nHeads = nHead + 1;
        drive.nSectors = nSectors;
        fInterrupt = true;
        break;
        
    default:
        if (DEBUG) this.messageDebugger("HDC.doATCommand(" + str.toHexByte(this.regCommand) + "): " + (bCmd < 0? ("invalid drive (" + iDrive + ")") : "unsupported operation"));
        if (DEBUG && DEBUGGER && this.dbg && this.dbg.messageEnabled(this.dbg.MESSAGE_HDC) && bCmd >= 0) this.cpu.haltCPU();
        break;
    }
    
    if (fInterrupt && this.chipset) this.chipset.setIRR(ChipSet.IRQ.ATC);
};

/**
 * doXTCommand()
 * 
 * Handles XTC (XT Controller) commands
 * 
 * @this {HDC}
 */
HDC.prototype.doXTCommand = function() 
{
    var hdc = this;
    this.regDataIndex = 0;
    
    var bCmd = this.popCmd();
    var bCmdOrig = bCmd;
    var b1 = this.popCmd();
    var bDrive = b1 & 0x20;
    var iDrive = (bDrive >> 5);

    var bHead = b1 & 0x1f;
    var b2 = this.popCmd();
    var b3 = this.popCmd();
    var wCylinder = ((b2 << 2) & 0x300) | b3;
    var bSector = b2 & 0x3f;
    var bCount = this.popCmd();             // block count or interleave count, depending on the command
    var bControl = this.popCmd();
    var bParm, bDataStatus;

    var drive = this.aDrives[iDrive];
    if (drive) {
        drive.wCylinder = wCylinder;
        drive.bHead = bHead;
        drive.bSector = bSector;
        drive.nBytes = bCount * drive.cbSector;
    }

    /*
     * I tried to save normal command processing from having to deal with invalid drives,
     * but the HDC BIOS initializes both drive 0 AND drive 1 on a HDC.XTC.DATA.CMD.INIT_DRIVE command,
     * and apparently that particular command has no problem with non-existent drives.
     * 
     * So I've separated the commands into two groups: drive-ambivalent commands should be
     * processed in the first group, and all the rest should be processed in the second group. 
     */
    switch (bCmd) {
    
    case HDC.XTC.DATA.CMD.REQUEST_SENSE:        // 0x03
        this.beginResult(drive? drive.errorCode : HDC.XTC.DATA.ERR.NOT_READY);
        this.pushResult(b1);
        this.pushResult(b2);
        this.pushResult(b3);
        /*
         * Although not terribly clear from IBM's "Fixed Disk Adapter" documentation, a data "status byte"
         * also follows the 4 "sense bytes".  Interestingly, The HDC BIOS checks that data status byte for
         * XTC.DATA.STATUS_ERROR, but I have to wonder if it would have ever been set for this command....
         *
         * The whole point of the HDC.XTC.DATA.CMD.REQUEST_SENSE command is to obtain details about a
         * previous error, so if HDC.XTC.DATA.CMD.REQUEST_SENSE itself reports an error, what would that mean?
         */
        this.pushResult(HDC.XTC.DATA.STATUS_OK | bDrive);
        bCmd = -1;                              // mark the command as complete
        break;
    
    case HDC.XTC.DATA.CMD.INIT_DRIVE:           // 0x0C
        /*
         * Pop off all the extra "Initialize Drive Characteristics" bytes and store them, for the benefit of
         * other functions, like verifyDrive().
         */
        var i = 0;
        while ((bParm = this.popCmd()) >= 0) {
            if (drive && i < drive.abDriveParms.length) {
                drive.abDriveParms[i++] = bParm;
            }
        }
        if (drive) this.verifyDrive(drive);
        bDataStatus = HDC.XTC.DATA.STATUS_OK;
        if (!drive && this.iDriveAllowFail == iDrive) {
            this.iDriveAllowFail = -1;
            if (DEBUG) this.messageDebugger("HDC.doXTCommand(): fake failure triggered");
            bDataStatus = HDC.XTC.DATA.STATUS_ERROR;
        }
        this.beginResult(bDataStatus | bDrive);
        bCmd = -1;                              // mark the command as complete
        break;
    
    case HDC.XTC.DATA.CMD.RAM_DIAGNOSTIC:       // 0xE0
    case HDC.XTC.DATA.CMD.CTL_DIAGNOSTIC:       // 0xE4
        this.beginResult(HDC.XTC.DATA.STATUS_OK | bDrive);
        bCmd = -1;                              // mark the command as complete
        break;
    
    default:
        break;
    }

    if (bCmd >= 0) {
        if (drive === undefined) {
            bCmd = -1;
        } else {
            /*
             * In preparation for this command, zero out the drive's errorCode and senseCode.
             * Commands that require a disk address should update senseCode with HDC.XTC.DATA.SENSE_ADDR_VALID.
             * And of course, any command that encounters an error should set the appropriate error code.
             */
            drive.errorCode = HDC.XTC.DATA.ERR.NONE;
            drive.senseCode = 0;
        }
        switch (bCmd) {
        case HDC.XTC.DATA.CMD.TEST_READY:       // 0x00
            this.beginResult(HDC.XTC.DATA.STATUS_OK | bDrive);
            break;
        
        case HDC.XTC.DATA.CMD.RECALIBRATE:      // 0x01
            drive.bControl = bControl;
            if (DEBUG) this.messageDebugger("HDC.doXTCommand(): drive " + iDrive + " control byte: 0x" + str.toHexByte(bControl));
            this.beginResult(HDC.XTC.DATA.STATUS_OK | bDrive);
            break;
        
        case HDC.XTC.DATA.CMD.READ_VERF:        // 0x05
            /*
             * This is a non-DMA operation, so we simply pretend everything is OK for now.  TODO: Revisit.
             */
            this.beginResult(HDC.XTC.DATA.STATUS_OK | bDrive);
            break;
        
        case HDC.XTC.DATA.CMD.READ_DATA:        // 0x08
            this.doRead(drive, function(bStatus) {
                hdc.beginResult(bStatus | bDrive);
            });
            break;
        
        case HDC.XTC.DATA.CMD.WRITE_DATA:       // 0x0A
            /*
             * QUESTION: The IBM TechRef (p.1-188) implies that bCount is used as part of HDC.XTC.DATA.CMD.WRITE_DATA command,
             * but it is omitted from the HDC.XTC.DATA.CMD.READ_DATA command.  Is that correct?  Note that, as far as the length
             * of the transfer is concerned, we rely exclusively on the DMA controller being programmed with the appropriate byte count.
             */
            this.doWrite(drive, function(bStatus) {
                hdc.beginResult(bStatus | bDrive);
            });
            break;
        
        case HDC.XTC.DATA.CMD.WRITE_BUFFER:     // 0x0F
            this.doWriteToBuffer(drive, function(bStatus) {
                hdc.beginResult(bStatus | bDrive);
            });
            break;
        
        default:
            if (DEBUG) this.messageDebugger("HDC.doXTCommand(" + str.toHexByte(bCmdOrig) + "): " + (bCmd < 0? ("invalid drive (" + iDrive + ")") : "unsupported operation"));
            this.beginResult(HDC.XTC.DATA.STATUS_ERROR | bDrive);
            if (DEBUG && DEBUGGER && this.dbg && this.dbg.messageEnabled(this.dbg.MESSAGE_HDC) && bCmd >= 0) this.cpu.haltCPU();
            break;
        }
    }
};

/**
 * popCmd()
 * 
 * @this {HDC}
 * @return {number}
 */
HDC.prototype.popCmd = function() 
{
    var bCmd = -1;
    var bCmdIndex = this.regDataIndex;
    if (bCmdIndex < this.regDataTotal) {
        bCmd = this.regDataArray[this.regDataIndex++];
        if (DEBUG && DEBUGGER && this.dbg && this.dbg.messageEnabled((bCmdIndex > 0? this.dbg.MESSAGE_PORT : 0) | this.dbg.MESSAGE_HDC)) {
            this.dbg.message("HDC.CMD[" + bCmdIndex + "]: 0x" + str.toHexByte(bCmd) + (!bCmdIndex && HDC.aXTCCommands[bCmd]? (" (" + HDC.aXTCCommands[bCmd] + ")") : ""));
        }
    }
    return bCmd;
};

/**
 * beginResult(bResult)
 * 
 * @this {HDC}
 * @param {number} [bResult]
 */
HDC.prototype.beginResult = function(bResult)
{
    this.regDataIndex = this.regDataTotal = 0;
    
    if (bResult !== undefined) {
        if (DEBUG) this.messageDebugger("HDC.beginResult(0x" + str.toHexByte(bResult) + ")");
        this.pushResult(bResult);
    }
    /*
     * After the Execution phase (eg, DMA Terminal Count has occurred, or the EOT sector has been read/written),
     * an interrupt is supposed to occur, signaling the beginning of the Result Phase.  Once the data "status byte"
     * has been read from XTC.DATA, the interrupt is cleared (see inXTCData).
     */
    if (this.chipset) this.chipset.setIRR(ChipSet.IRQ.XTC);
    this.regStatus |= HDC.XTC.STATUS.INTERRUPT;
};

/**
 * pushResult(bResult)
 * 
 * @this {HDC}
 * @param {number} bResult
 */
HDC.prototype.pushResult = function(bResult)
{
    if (DEBUG && DEBUGGER && this.dbg && this.dbg.messageEnabled((this.regDataTotal > 0? this.dbg.MESSAGE_PORT : 0) | this.dbg.MESSAGE_HDC)) this.dbg.message("HDC.RES[" + this.regDataTotal + "]: 0x" + str.toHexByte(bResult));
    this.regDataArray[this.regDataTotal++] = bResult;
};

/**
 * dmaRead(drive, b, done)
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b
 * @param {function(number,boolean)} done
 */
HDC.prototype.dmaRead = function(drive, b, done)
{
    if (b === undefined || b < 0) {
        this.readByte(drive, done);
        return;
    }
    /*
     * The DMA controller should be ASKING for data, not GIVING us data; this suggests an internal DMA miscommunication
     */
    if (DEBUG) this.messageDebugger("dmaRead(): invalid DMA acknowledgement");
    done(-1, false);
};

/**
 * dmaWrite(drive, b)
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b
 * @return {number}
 */
HDC.prototype.dmaWrite = function(drive, b)
{
    if (b !== undefined && b >= 0)
        return this.writeByte(drive, b);
    /*
     * The DMA controller should be GIVING us data, not ASKING for data; this suggests an internal DMA miscommunication
     */
    if (DEBUG) this.messageDebugger("dmaWrite(): invalid DMA acknowledgement");
    return -1;
};

/**
 * dmaWriteBuffer(drive, b)
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b
 * @return {number}
 */
HDC.prototype.dmaWriteBuffer = function(drive, b)
{
    if (b !== undefined && b >= 0)
        return this.writeBuffer(drive, b);
    /*
     * The DMA controller should be GIVING us data, not ASKING for data; this suggests an internal DMA miscommunication
     */
    if (DEBUG) this.messageDebugger("dmaWriteBuffer(): invalid DMA acknowledgement");
    return -1;
};

/**
 * dmaWriteFormat(drive, b)
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b
 * @returns {number}
 */
HDC.prototype.dmaWriteFormat = function(drive, b)
{
    if (b !== undefined && b >= 0)
        return this.writeFormat(drive, b);
    /*
     * The DMA controller should be GIVING us data, not ASKING for data; this suggests an internal DMA miscommunication
     */
    if (DEBUG) this.messageDebugger("dmaWriteFormat(): invalid DMA acknowledgement");
    return -1;
};

/**
 * doRead(drive, done)
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {function(number)} done (dataStatus is XTC.DATA.STATUS_OK or XTC.DATA.STATUS_ERROR; if error, then drive.errorCode should be set as well)
 */
HDC.prototype.doRead = function(drive, done)
{
    drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;

    if (DEBUG) this.messageDebugger("HDC.doRead(" + drive.wCylinder + ":" + drive.bHead + ":" + drive.bSector + ")");

    // if (DEBUG) this.messageDebugger("HDC.doRead(head=" + str.toHexByte(drive.bHead) + ",cyl=" + str.toHexWord(drive.wCylinder) + ",sec=" + str.toHexByte(drive.bSector) + ")");
    
    if (drive.disk) {
        drive.sector = null;
        if (this.chipset) {
            /*
             * We need to reverse the original logic, and default to success unless/until an actual error occurs;
             * otherwise dmaRead()/readByte() will bail on us.  The original approach used to work because requestDMA()
             * would immediately call us back with fComplete set to true EVEN if the DMA channel was not yet unmasked;
             * now the callback is deferred until the DMA channel has been unmasked and the DMA request has finished.
             */
            drive.errorCode = HDC.XTC.DATA.ERR.NONE;
            this.chipset.connectDMA(ChipSet.DMA_HDC, this, 'dmaRead', drive);
            this.chipset.requestDMA(ChipSet.DMA_HDC, function(fComplete) {
                if (!fComplete) {
                    /*
                     * If an incomplete request wasn't triggered by an explicit error, then let's make explicit
                     * (ie, revert to the default failure code that we originally set above). 
                     */
                    if (drive.errorCode == HDC.XTC.DATA.ERR.NONE) {
                        drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;
                    }
                }
                done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
            });
            return;
        }
    }
    done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
};

/**
 * doWrite(drive, done)
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {function(number)} done (dataStatus is XTC.DATA.STATUS_OK or XTC.DATA.STATUS_ERROR; if error, then drive.errorCode should be set as well)
 */
HDC.prototype.doWrite = function(drive, done)
{
    drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;

    if (DEBUG) this.messageDebugger("HDC.doWrite(" + drive.wCylinder + ":" + drive.bHead + ":" + drive.bSector + ")");

    // if (DEBUG) this.messageDebugger("HDC.doWrite(head=" + str.toHexByte(drive.bHead) + ",cyl=" + str.toHexWord(drive.wCylinder) + ",sec=" + str.toHexByte(drive.bSector) + ")");
    
    if (drive.disk) {
        drive.sector = null;
        if (this.chipset) {
            /*
             * We need to reverse the original logic, and default to success unless/until an actual error occurs;
             * otherwise dmaWrite()/writeByte() will bail on us.  The original approach would work because requestDMA()
             * would immediately call us back with fComplete set to true EVEN if the DMA channel was not yet unmasked;
             * now the callback is deferred until the DMA channel has been unmasked and the DMA request has finished.
             */
            drive.errorCode = HDC.XTC.DATA.ERR.NONE;
            this.chipset.connectDMA(ChipSet.DMA_HDC, this, 'dmaWrite', drive);
            this.chipset.requestDMA(ChipSet.DMA_HDC, function(fComplete) {
                if (!fComplete) {
                    /*
                     * If an incomplete request wasn't triggered by an explicit error, then let's make explicit
                     * (ie, revert to the default failure code that we originally set above). 
                     */
                    if (drive.errorCode == HDC.XTC.DATA.ERR.NONE) {
                        drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;
                    }
                    /*
                     * Mask any error that's the result of an attempt to write beyond the end of the track (which is
                     * something the MS-DOS 4.0M's FORMAT utility seems to like to do).
                     */
                    if (drive.errorCode == HDC.XTC.DATA.ERR.NO_SECTOR) {
                        drive.errorCode = HDC.XTC.DATA.ERR.NONE;
                    }
                }
                done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
            });
            return;
        }
    }
    done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
};

/**
 * doWriteToBuffer(drive, done)
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {function(number)} done (dataStatus is XTC.DATA.STATUS_OK or XTC.DATA.STATUS_ERROR; if error, then drive.errorCode should be set as well)
 */
HDC.prototype.doWriteToBuffer = function(drive, done)
{
    drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;
    
    if (DEBUG) this.messageDebugger("HDC.doWriteToBuffer()");
    
    if (!drive.abSector || drive.abSector.length != drive.nBytes) {
        drive.abSector = new Array(drive.nBytes);
    }
    drive.ibSector = 0;
    if (this.chipset) {
        /*
         * We need to reverse the original logic, and default to success unless/until an actual error occurs;
         * otherwise dmaWriteBuffer() will bail on us.  The original approach would work because requestDMA()
         * would immediately call us back with fComplete set to true EVEN if the DMA channel was not yet unmasked;
         * now the callback is deferred until the DMA channel has been unmasked and the DMA request has finished.
         */
        drive.errorCode = HDC.XTC.DATA.ERR.NONE;
        this.chipset.connectDMA(ChipSet.DMA_HDC, this, 'dmaWriteBuffer', drive);
        this.chipset.requestDMA(ChipSet.DMA_HDC, function(fComplete) {
            if (!fComplete) {
                /*
                 * If an incomplete request wasn't triggered by an explicit error, then let's make explicit
                 * (ie, revert to the default failure code that we originally set above). 
                 */
                if (drive.errorCode == HDC.XTC.DATA.ERR.NONE) {
                    drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;
                }
            }
            done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
        });
        return;
    }
    done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
};

/**
 * doFormat(drive, done)
 *
 * The drive variable is initialized by doXTCommand() to the following extent:
 *
 *      drive.bHead (ignored)
 *      drive.nBytes (bytes/sector)
 *      drive.bSectorEnd (sectors/track)
 *      drive.bFiller (fill byte)
 *
 * and we expect the DMA controller to provide C, H, R and N (ie, 4 bytes) for each sector to be formatted.
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {function(number)} done (dataStatus is XTC.DATA.STATUS_OK or XTC.DATA.STATUS_ERROR; if error, then drive.errorCode should be set as well)
 */
HDC.prototype.doFormat = function(drive, done)
{
    drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;
    
    // if (DEBUG) this.messageDebugger("HDC.doFormat()");
    
    if (drive.disk) {
        drive.sector = null;
        if (this.chipset) {
            drive.cbFormat = 0;
            drive.abFormat = new Array(4);
            drive.bFormatting = true;
            drive.cSectorsFormatted = 0;
            /*
             * We need to reverse the original logic, and default to success unless/until an actual error occurs;
             * otherwise dmaWriteFormat() will bail on us.  The original approach would work because requestDMA()
             * would immediately call us back with fComplete set to true EVEN if the DMA channel was not yet unmasked;
             * now the callback is deferred until the DMA channel has been unmasked and the DMA request has finished.
             */
            drive.errorCode = HDC.XTC.DATA.ERR.NONE;
            this.chipset.connectDMA(ChipSet.DMA_HDC, this, 'dmaWriteFormat', drive);
            this.chipset.requestDMA(ChipSet.DMA_HDC, function(fComplete) {
                if (!fComplete) {
                    /*
                     * If an incomplete request wasn't triggered by an explicit error, then let's make explicit
                     * (ie, revert to the default failure code that we originally set above). 
                     */
                    if (drive.errorCode == HDC.XTC.DATA.ERR.NONE) {
                        drive.errorCode = HDC.XTC.DATA.ERR.NOT_READY;
                    }
                }
                drive.bFormatting = false;
                done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
            });
            return;
        }
    }
    done(drive.errorCode? HDC.XTC.DATA.STATUS_ERROR : HDC.XTC.DATA.STATUS_OK);
};

/**
 * readByte(drive, done)
 *
 * The following drive variable properties must have been setup prior to our first call:
 *
 *      drive.wCylinder
 *      drive.bHead
 *      drive.bSector
 *      drive.sector (initialized to null)
 *
 * On the first readByte() request, since drive.sector will be null, we ask the Disk object to look
 * up the first sector of the request.  We then ask the Disk for bytes from that sector until the sector
 * is exhausted, and then we look up the next sector and continue the process.
 *
 * NOTE: Since the HDC isn't aware of the extent of the transfer, all readByte() can do is return bytes
 * until the current track (or, in the case of a multi-track request, the current cylinder) has been exhausted.
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {function(number,boolean)} [done] (number is next available byte from drive, or -1 if no more bytes available)
 * @param {boolean} [fAutoInc] (default is true to auto-increment)
 * @return {number} the requested byte, or -1 if unavailable
 */
HDC.prototype.readByte = function(drive, done, fAutoInc)
{
    var b = -1;
    
    if (drive.errorCode) {
        if (done) done(b, false);
        return b;
    }
    
    var inc = (fAutoInc !== false? 1 : 0);
    
    if (drive.sector) {
        b = drive.disk.read(drive.sector, drive.ibSector);
        drive.ibSector += inc;
        if (b >= 0) {
            if (done) done(b, false);
            return b;
        }
    }
    
    /*
     * Locate the next sector, and then try reading again.
     *
     * Important difference between the FDC and the XTC: the XTC uses 0-based sector numbers,
     * hence the bSectorBias below.  I could change how sector numbers are stored in the image,
     * but it seems preferable to keep the image format consistent and controller-independent.
     */
    if (done) {
        var hdc = this;
        drive.disk.seek(drive.wCylinder, drive.bHead, drive.bSector +
        drive.bSectorBias, false, function (sector, fAsync)
        {
            var b = -1;
            if ((drive.sector = sector)) {
                drive.ibSector = 0;
                /*
                 * We "pre-advance" bSector et al now, instead of waiting to advance it right before the seek().
                 * This allows the initial call to readByte() to perform a seek without triggering an unwanted advance.
                 */
                hdc.advanceSector(drive);
                b = drive.disk.read(drive.sector, drive.ibSector);
                drive.ibSector += inc;
            } else {
                drive.errorCode = HDC.XTC.DATA.ERR.NO_SECTOR;
            }
            done(b, fAsync);
        });
    }    
    return b;
};

/**
 * writeByte(drive, b)
 *
 * The following drive variable properties must have been setup prior to our first call:
 *
 *      drive.wCylinder
 *      drive.bHead
 *      drive.bSector
 *      drive.sector (initialized to null)
 *
 * On the first writeByte() request, since drive.sector will be null, we ask the Disk object to look
 * up the first sector of the request.  We then send the Disk bytes for that sector until the sector
 * is full, and then we look up the next sector and continue the process.
 *
 * NOTE: Since the HDC isn't aware of the extent of the transfer, all writeByte() can do is accept bytes
 * until the current track (or, in the case of a multi-track request, the current cylinder) has been exhausted.
 *
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b containing next byte to write
 * @return {number} (b unchanged; return -1 if command should be terminated)
 */
HDC.prototype.writeByte = function(drive, b)
{
    if (drive.errorCode) return -1;
    do {
        if (drive.sector) {
            if (drive.disk.write(drive.sector, drive.ibSector++, b))
                break;
        }
        /*
         * Locate the next sector, and then try writing again.
         *
         * Important difference between the FDC and the XTC: the XTC uses 0-based sector numbers,
         * hence the bSectorBias below.  I could change how sector numbers are stored in the image,
         * but it seems preferable to keep the image format consistent and controller-independent.
         */
        drive.disk.seek(drive.wCylinder, drive.bHead, drive.bSector + drive.bSectorBias, true, function(sector, fAsync) {
            drive.sector = sector;
        });
        if (!drive.sector) {
            drive.errorCode = HDC.XTC.DATA.ERR.NO_SECTOR;
            b = -1;
            break;
        }
        drive.ibSector = 0;
        /*
         * We "pre-advance" bSector et al now, instead of waiting to advance it right before the seek().
         * This allows the initial call to writeByte() to perform a seek without triggering an unwanted advance.
         */
        this.advanceSector(drive);
    } while (true);
    return b;
};

/**
 * advanceSector(drive)
 *
 * This increments the sector number; when the sector number reaches drive.nSectors on the current track, we
 * increment drive.bHead and reset drive.bSector, and when drive.bHead reaches drive.nHeads, we reset drive.bHead
 * and increment drive.wCylinder.
 * 
 * One wrinkle is that the ATC uses 1-based sector numbers (bSectorBias is 0), whereas the XTC uses 0-based sector
 * numbers (bSectorBias is 1).  Thus, the correct "reset" value for bSector is (1 - bSectorBias), and the correct
 * limit for bSector is (nSectors + bSectorStart).
 * 
 * @param {Object} drive
 */
HDC.prototype.advanceSector = function(drive)
{
    drive.bSector++;
    var bSectorStart = (1 - drive.bSectorBias);
    if (drive.bSector >= drive.nSectors + bSectorStart) {
        drive.bSector = bSectorStart;
        drive.bHeads++;
        if (drive.bHeads >= drive.nHeads) {
            drive.bHeads = 0;
            drive.wCylinder++;
            Component.assert(drive.wCylinder < drive.nCylinders);
        }
    }
};

/**
 * writeBuffer(drive, b)
 *
 * NOTE: Since the HDC isn't aware of the extent of the transfer, all writeBuffer() can do is accept bytes
 * until the buffer is full.
 *
 * TODO: Support for HDC.XTC.DATA.CMD.READ_BUFFER is missing, and support for HDC.XTC.DATA.CMD.WRITE_BUFFER may not be complete;
 * tests required.
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b containing next byte to write
 * @return {number} (b unchanged; return -1 if command should be terminated)
 */
HDC.prototype.writeBuffer = function(drive, b)
{
    if (drive.ibSector < drive.abSector.length) {
        drive.abSector[drive.ibSector++] = b;
    } else {
        /*
         * TODO: Determine the proper error code to return here. 
         */
        drive.errorCode = HDC.XTC.DATA.ERR.NO_SECTOR;
        b = -1;
    }
    return b;
};

/**
 * writeFormat(drive, b)
 * 
 * @this {HDC}
 * @param {Object} drive
 * @param {number} b containing a format command byte
 * @return {number} (b if successful, -1 if command should be terminated)
 */
HDC.prototype.writeFormat = function(drive, b)
{
    if (drive.errorCode) return -1;
    drive.abFormat[drive.cbFormat++] = b;
    if (drive.cbFormat == drive.abFormat.length) {
        drive.wCylinder = drive.abFormat[0];    // C
        drive.bHead = drive.abFormat[1];        // H
        drive.bSector = drive.abFormat[2];      // R
        drive.nBytes = 128 << drive.abFormat[3];// N (0 => 128, 1 => 256, 2 => 512, 3 => 1024)
        drive.cbFormat = 0;

        if (DEBUG) this.messageDebugger("HDC.writeFormat(" + drive.wCylinder + ":" + drive.bHead + ":" + drive.bSector + ":" + drive.nBytes + ")");

        // if (DEBUG) this.messageDebugger("HDC.writeFormat(head=" + str.toHexByte(drive.bHead) + ",cyl=" + str.toHexWord(drive.wCylinder) + ",sec=" + str.toHexByte(drive.bSector) + ",len=" + str.toHexWord(drive.nBytes) + ")");
        
        for (var i = 0; i < drive.nBytes; i++) {
            if (this.writeByte(drive, drive.bFiller) < 0) {
                return -1;
            }
        }
        drive.cSectorsFormatted++;
    }
    if (drive.cSectorsFormatted >= drive.bSectorEnd) b = -1;
    return b;
};

/**
 * intBIOSDisk(addr)
 *
 * NOTE: This function differentiates HDC requests from FDC requests, based on whether the INT 0x13 drive number
 * in DL is >= 0x80.
 *
 * HACK: The HDC BIOS code for both INT 0x13/AH=0x00 and INT 0x13/AH=0x09 calls "INIT_DRV" @C800:0427, which is
 * hard-coded to issue the HDC.XTC.DATA.CMD.INIT_DRIVE command for BOTH drives 0 and 1 (aka drive numbers 0x80 and
 * 0x81), regardless of the drive number specified in DL; this means that the HDC.XTC.DATA.CMD.INIT_DRIVE command
 * must always succeed for drive 1 if it also succeeds for drive 0 -- even if there is no drive 1.  Bizarre, but OK,
 * whatever.
 *
 * So assuming we a have drive 0, when the power-on diagnostics in "DISK_SETUP" @C800:0003 call INT 0x13/AH=0x09
 * (@C800:00DB) for drive 0, it must succeed.  No problem.  But when "DISK_SETUP" starts probing for additional drives,
 * it first issues INT 0x13/AH=0x00, followed by INT 0x13/AH=0x11, and finally INT 0x13/AH=0x09.  If the first
 * (AH=0x00) or third (AH=0x09) INT 0x13 fails, it quickly moves on (ie, it jumps to "POD_DONE").  But as we just
 * discussed, both those operations call "INIT_DRV", which can't return an error.  This means the only function that
 * can return an error in this context is the recalibrate function (AH=0x11).  That sucks, because the way the HDC
 * BIOS is written, it will loop for anywhere from 1.5 seconds to 25 seconds (depending on whether the controller
 * is part of the "System Unit" or not; see port 0x213), attempting to recalibrate drive 1 until it finally times out.
 *
 * Normally, you'll only experience the 1.5 second delay, but even so, it's a ridiculous waste of time and a lot of
 * useless INT 0x13 calls.  So I monitor INT 0x13/AH=0x00 for DL >= 0x80 and set a special HDC.XTC.DATA.CMD.INIT_DRIVE
 * override flag (iDriveAllowFail) that will allow that command to fail, and in theory, make the the HDC BIOS
 * "DISK_SETUP" code much more efficient.
 *
 * @this {HDC}
 * @param {number} addr
 * @return {boolean} true to proceed with the INT 0x13 software interrupt, false to skip
 */
HDC.prototype.intBIOSDisk = function(addr)
{
    var AH = this.cpu.regAX >> 8;
    var DL = this.cpu.regDX & 0xff;
    if (!AH && DL > 0x80) this.iDriveAllowFail = DL - 0x80;
    if (DEBUGGER) {
        if (this.dbg && this.dbg.messageEnabled(this.dbg.MESSAGE_HDC) && DL >= 0x80) {
            this.dbg.message("HDC.intBIOSDisk(AX=" + str.toHexWord(this.cpu.regAX) + ",DL=" + str.toHexByte(DL) + ") at " + str.toHexAddr(addr - this.cpu.segCS.base, this.cpu.segCS.sel));
            // this.cpu.haltCPU();
            this.cpu.addInterruptReturn(addr, function (hdc, nCycles) {
                return function onBIOSDiskReturn(nLevel) {
                    nCycles = hdc.cpu.getCycles() - nCycles;
                    hdc.messageDebugger("HDC.intBIOSDisk(" + nLevel + "): C=" + (hdc.cpu.getCF()? 1 : 0) + " (cycles=" + nCycles + ")");
                    // if (DEBUG && nCycles > 10000) hdc.cpu.haltCPU();
                };
            }(this, this.cpu.getCycles()));
        }
    }
    return true;
};

/**
 * intBIOSDiskette(addr)
 *
 * When the HDC BIOS overwrites the ROM BIOS INT 0x13 address, it saves the original INT 0x13 address
 * in the INT 0x40 vector.  This function intercepts calls to that vector to work around a minor nuisance.
 *
 * The HDC BIOS's plan was simple, albeit slightly flawed: assign fixed disks drive numbers >= 0x80,
 * and whenever someone calls INT 0x13 with a drive number < 0x80, invoke the original INT 0x13 diskette
 * code via INT 0x40 and return via RET 2.
 *
 * Unfortunately, not all original INT 0x13 functions required a drive number in DL (eg, the "reset"
 * function, where AH=0).  And the HDC BIOS knew this, which is why, in the case of the "reset" function,
 * the HDC BIOS performs BOTH an INT 0x40 diskette reset AND an HDC reset -- it can't be sure which
 * controller the caller really wants to reset.
 *
 * An unfortunate side-effect of this behavior: when the HDC BIOS is initialized for the first time, it may
 * issue several resets internally, depending on whether there are 0, 1 or 2 hard disks installed, and each
 * of those resets also triggers completely useless diskette resets, each wasting up to two seconds waiting
 * for the FDC to interrupt.  The FDC tries to interrupt, but it can't, because at this early stage of
 * ROM BIOS initialization, IRQ.FDC hasn't been unmasked yet.
 *
 * My work-around: have the HDC component hook INT 0x40, and every time an INT 0x40 is issued with AH=0 and
 * IRQ.FDC masked, bypass the INT 0x40 interrupt.  This is as close as PCjs has come to patching any BIOS code
 * (something I've refused to do), and even here, I'm not doing it out of necessity, just annoyance.
 *
 * @this {HDC}
 * @param {number} addr
 * @return {boolean} true to proceed with the INT 0x40 software interrupt, false to skip
 */
HDC.prototype.intBIOSDiskette = function(addr)
{
    var AH = this.cpu.regAX >> 8;
    if ((!AH && this.chipset && this.chipset.checkIMR(ChipSet.IRQ.FDC))) {
        if (DEBUG) this.messageDebugger("HDC.intBIOSDiskette(): skipping useless INT 0x40 diskette reset");
        return false;
    }
    return true;
};

/**
 * messageDebugger(sMessage)
 *
 * This is a combination of the Debugger's messageEnabled(MESSAGE_HDC) and message() functions, for convenience.
 * 
 * @this {HDC}
 * @param {string} sMessage is any caller-defined message string
 */
HDC.prototype.messageDebugger = function(sMessage)
{
    if (DEBUGGER && this.dbg) {
        if (this.dbg.messageEnabled(this.dbg.MESSAGE_HDC)) {
            this.dbg.message(sMessage);
        }
    }
};

/**
 * messagePort(port, bOut, addrFrom, name, bIn)
 *
 * This is an internal version of the Debugger's messagePort() function, for convenience.
 * 
 * @this {HDC}
 * @param {number} port
 * @param {number|null} bOut if an output operation
 * @param {number|null} [addrFrom]
 * @param {string|null} [name] of the port, if any
 * @param {number} [bIn] is the input value, if known, on an input operation
 */
HDC.prototype.messagePort = function(port, bOut, addrFrom, name, bIn)
{
    if (DEBUGGER && this.dbg) {
        this.dbg.messagePort(this, port, bOut, addrFrom, name, this.dbg.MESSAGE_HDC, bIn);
    }
};

/*
 * Port input notification tables
 */
HDC.aXTCPortInput = {
    0x320:  HDC.prototype.inXTCData,
    0x321:  HDC.prototype.inXTCStatus,
    0x322:  HDC.prototype.inXTCConfig
};

HDC.aATCPortInput = {
    0x1F0:  HDC.prototype.inATCData,
    0x1F1:  HDC.prototype.inATCError,
    0x1F2:  HDC.prototype.inATCSecCnt,
    0x1F3:  HDC.prototype.inATCSecNum,
    0x1F4:  HDC.prototype.inATCCylLo,
    0x1F5:  HDC.prototype.inATCCylHi,
    0x1F6:  HDC.prototype.inATCDrvHd,
    0x1F7:  HDC.prototype.inATCStatus
};

/*
 * Port output notification tables
 */
HDC.aXTCPortOutput = {
    0x320:  HDC.prototype.outXTCData,
    0x321:  HDC.prototype.outXTCReset,
    0x322:  HDC.prototype.outXTCPulse,
    0x323:  HDC.prototype.outXTCPattern,
    /*
     * The PC XT Fixed Disk BIOS includes some additional "housekeeping" that it performs
     * not only on port 0x323 but also on three additional ports, at increments of 4 (see all
     * references to "RESET INT/DMA MASK" in the Fixed Disk BIOS).  It's not clear to me if
     * those ports refer to additional HDC controllers, and I haven't seen other references to
     * them, but in any case, they represent a lot of "I/O noise" that we simply squelch here.
     */
    0x327:  HDC.prototype.outXTCNoise,
    0x32B:  HDC.prototype.outXTCNoise,
    0x32F:  HDC.prototype.outXTCNoise
};

HDC.aATCPortOutput = {
    0x1F0:  HDC.prototype.outATCData,
    0x1F1:  HDC.prototype.outATCWPreC,
    0x1F2:  HDC.prototype.outATCSecCnt,
    0x1F3:  HDC.prototype.outATCSecNum,
    0x1F4:  HDC.prototype.outATCCylLo,
    0x1F5:  HDC.prototype.outATCCylHi,
    0x1F6:  HDC.prototype.outATCDrvHd,
    0x1F7:  HDC.prototype.outATCCommand
};

/**
 * HDC.init()
 *
 * This function operates on every element (e) of class "hdc", and initializes
 * all the necessary HTML to construct the HDC module(s) as spec'ed.
 *
 * Note that each element (e) of class "hdc" is expected to have a "data-value"
 * attribute containing the same JSON-encoded parameters that the HDC constructor expects.
 */
HDC.init = function()
{
    var aeHDC = Component.getElementsByClass(window.document, PCJSCLASS, "hdc");
    for (var iHDC = 0; iHDC < aeHDC.length; iHDC++) {
        var eHDC = aeHDC[iHDC];
        var parmsHDC = Component.getComponentParms(eHDC);
        var hdc = new HDC(parmsHDC);
        Component.bindComponentControls(hdc, eHDC, PCJSCLASS);
    }
};

/*
 * Initialize every Hard Drive Controller (HDC) module on the page.
 */
web.onInit(HDC.init);

if (typeof APP_PCJS !== 'undefined') APP_PCJS.HDC = HDC;

if (typeof module !== 'undefined') module.exports = HDC;
